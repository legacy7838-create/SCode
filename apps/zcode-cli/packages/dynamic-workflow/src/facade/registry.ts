import ts from "typescript";
import { FACADE_FILE_NAME } from "./dts.js";

/**
 * The world-read registry:
 * the single source of truth for **(facade container, member) -> op**. One table, three consumers — the site collection in
 * `analysis/sites.ts`, the facade-siting diagnostics in `analysis/facade-misuse.ts`, and the rewrite in
 * `lowering/lower.ts` — so adding a world-read primitive means **adding one line**, and not a single
 * consumer line changes.
 *
 * ————————————————————————————————————————————————————————————————
 * Why the key must carry the **declaring container** and cannot use the bare member name
 * ————————————————————————————————————————————————————————————————
 * `git.log` collides in name with the top-level `log()`. A bare name set has only two possible outcomes: mint a
 * world-read site for every single progress message, or drop `git.log`'s site entirely — and a facade call without a site has
 * no journal key, which is exactly the kind of unreliability the facade-siting rule exists to prevent. Facade
 * identity has long been **decided by declaration** elsewhere (the misuse pass resolves the callee's symbol, not its
 * spelling), so this is only applying that one same rule consistently, not introducing a new one.
 *
 * The op union type is **derived** from the table (see {@link WorldReadOp}): adding one row widens Boundary A's op
 * vocabulary, with no need to touch a type declaration as well — that is the usual starting point of a
 * second source of truth.
 */

/** One registry row: a member on a facade container, mapped to one op of Boundary A. */
interface WorldReadRow {
  /** The name of the facade container that declares that member (the `files` of `declare const files: {...}`). */
  readonly container: string;
  /** The member name on the container (the `glob` of `files.glob`). */
  readonly member: string;
  /** The op name of Boundary A. It need **not** equal the member name: `git.log` -> `"git-log"`. */
  readonly op: string;
}

/**
 * The world-read registry. Adding a primitive = adding one line.
 *
 * The `git.log` row is the reason this table exists: its member name collides with the top-level `log()`, and here the
 * key carries the container, so the two never meet (see the top of this module).
 */
export const WORLD_READ_REGISTRY = [
  { container: "files", member: "glob", op: "glob" },
  { container: "files", member: "read", op: "read" },
  { container: "files", member: "grep", op: "grep" },
  { container: "git", member: "changedFiles", op: "git-changed-files" },
  { container: "git", member: "diff", op: "git-diff" },
  { container: "git", member: "status", op: "git-status" },
  { container: "git", member: "log", op: "git-log" },
  // world.run: journal-based command execution. The same table, the same set
  // Mechanism - The difference between "read" and "effect" lies in the authorization aspect (compile-time literal cmd + confirmation window) and journal
  // Node type (world-run), not site identity.
  { container: "world", member: "run", op: "run" },
] as const satisfies readonly WorldReadRow[];

/**
 * A world read operation (read-only, journalable). Derived from the registry, so adding one line widens the op
 * vocabulary. Both Boundary A's `worldRead(siteId, op, args)` and the journal's `inputHash({op, args})` use it.
 */
export type WorldReadOp = (typeof WORLD_READ_REGISTRY)[number]["op"];

/**
 * The artifact registry: the six members of the `artifact` container
 * -> the six ops of Boundary A. **Same shape as the world-read registry but a separate table**, deliberately:
 *
 * Every row of the world-read table eventually lands in `driver.executeWorldRead` and means "read", while the two families of
 * artifacts are one an effect that writes the store (`publishArtifact`) and one that never goes through the driver at
 * all (`declareArtifact`). Mixing them into one table would make the world-read branch in each of the three places —
 * misuse, lowering, engine — carry an "unless it is actually an artifact" fork, and those
 * three are exactly the places that most ought to change by zero lines when a primitive is added.
 *
 * ⚠ Terminology: the artifact here is a **user-facing artifact**, not the engine's internal top-level return value.
 */
export interface ArtifactRow {
  /** The name of the facade container that declares that member (always `artifact`). */
  readonly container: "artifact";
  /** The member name on the container. */
  readonly member: string;
  /** The op name of Boundary A (identical to the member name — artifact members have no name-collision history like `git.log`). */
  readonly op: string;
  /**
   * The member family. `content` is an effect (async, through the driver, rejectable), `preset` is a declaration
   * (synchronous void, not through the driver). The family decides whether lowering rewrites to
   * `publishArtifact` or to `declareArtifact`, and also decides whether exceeding the limit produces a node
   * rejection or a failRun, so it has to live in the same row as the op instead of being decided three times over.
   */
  readonly family: "content" | "preset";
}

/** The artifact registry. Adding one artifact kind = adding one line. */
export const ARTIFACT_REGISTRY = [
  { container: "artifact", member: "file", op: "file", family: "content" },
  { container: "artifact", member: "markdown", op: "markdown", family: "content" },
  { container: "artifact", member: "chart", op: "chart", family: "preset" },
  { container: "artifact", member: "table", op: "table", family: "preset" },
  { container: "artifact", member: "metrics", op: "metrics", family: "preset" },
  { container: "artifact", member: "board", op: "board", family: "preset" },
] as const satisfies readonly ArtifactRow[];

/** All artifact ops (the six members). Derived from the registry, so adding one line widens the vocabulary. */
export type ArtifactOp = (typeof ARTIFACT_REGISTRY)[number]["op"];

/** The op of a content member (an effect: async, through the driver, returning an `ArtifactRef`). */
export type ArtifactContentOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "content" }
>["op"];

/** The op of a preset member (a declaration: synchronous void, not through the driver). */
export type ArtifactPresetOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "preset" }
>["op"];

/**
 * Registry lookup: (container, member) -> the artifact row. A non-artifact member returns undefined.
 *
 * It returns the **literal type of the table element** (rather than the widened {@link ArtifactRow}): the unions of `op` and
 * `family` are derived entirely from this table, and widening them once reduces them back to `string`, after which the
 * site table and the lowering lose their dispatch basis too.
 */
function artifactRow(
  container: string | undefined,
  member: string,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  if (container === undefined) return undefined;
  return ARTIFACT_REGISTRY.find((row) => row.container === container && row.member === member);
}

/** The artifact row a certain facade symbol resolves to (decided by the declaring container); undefined for a non-artifact member. */
export function artifactRowOfSymbol(
  symbol: ts.Symbol | undefined,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return artifactRow(member.container, member.member);
}

/** Which family a certain artifact op belongs to. The op is derived from the registry, so a lookup here always hits. */
export function artifactFamilyOf(op: ArtifactOp): "content" | "preset" {
  const row = ARTIFACT_REGISTRY.find((candidate) => candidate.op === op);
  if (row === undefined) throw new Error(`unknown artifact op: ${op}`);
  return row.family;
}

/** Whether that op is a preset member (the declaration family). Both the engine and the analyzers dispatch two completely different paths by it. */
export function isArtifactPresetOp(op: string): op is ArtifactPresetOp {
  return ARTIFACT_REGISTRY.some((row) => row.op === op && row.family === "preset");
}

/**
 * The container `ask` lives in: not a world-read, but equally a facade member that **produces a site**, so the facade-siting
 * rule constrains it too (direct calls only). It is placed here so that there is a single list of
 * "which members produce sites".
 */
const ASK_MEMBER = { container: "Agent", member: "ask" } as const;

/** The top-level facade functions that produce sites (no container). `log` produces no site, so it is not here. */
const SITE_PRODUCING_FUNCTIONS = ["agent", "report"] as const;

/**
 * The names of the top-level site-producing facade functions. The bare-callee branch of `sites.ts` dispatches by
 * them, so "which top-level function produces a site" is answered by this one list only.
 *
 * `report` is here and `log` is not; the difference is not one of severity but of **whether there is a journal key**:
 * report has a `dwf_node` row (replayed deduplicated by site x ordinal), so the facade-siting rule
 * (direct calls only) has to constrain it — a report call without a site is a journal record without a key.
 * `log` has no site, and therefore nothing that aliasing could break.
 */
type SiteProducingFunction = (typeof SITE_PRODUCING_FUNCTIONS)[number];

/**
 * The site-producing **top-level function** a certain facade symbol resolves to (decided by declaration: the container
 * must be absent). A non-facade symbol, a member of a facade container, and a top-level function that
 * produces no site such as `log` all return undefined.
 */
export function siteProducingFunctionOfSymbol(
  symbol: ts.Symbol | undefined,
): SiteProducingFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return SITE_PRODUCING_FUNCTIONS.find((name) => name === member.member);
}

/**
 * The **display-only marker** among the top-level facade functions: it has facade identity but produces no site. Today only `phase` is one.
 *
 * Why it is not inside {@link SITE_PRODUCING_FUNCTIONS} and instead stands in a column of its own: that list answers
 * "which top-level function produces a site", while `phase` has no site id, no journal row and no host call —
 * lowering simply erases it into `void 0`. Mixing it into the site-producing list would make facade-misuse's
 * pass 2 ("a direct call that produces a site but was never sited") reject every legitimate `phase("gate")`.
 *
 * It is still a facade function declaration, so an alias escape (`const p = phase`) is rejected by facade-misuse's
 * pass 1 as before — which lets lowering erase it confidently by node identity.
 */
const MARKER_FUNCTIONS = ["phase"] as const;

/** The names of the top-level display-marker facade functions. Derived from {@link MARKER_FUNCTIONS}; adding one marker is adding one line. */
type MarkerFunction = (typeof MARKER_FUNCTIONS)[number];

/**
 * The **display marker** top-level function a certain facade symbol resolves to (decided by declaration: the container
 * must be absent); undefined when it is not a marker. Shaped like {@link siteProducingFunctionOfSymbol} and deliberately
 * a different table.
 */
export function markerFunctionOfSymbol(symbol: ts.Symbol | undefined): MarkerFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return MARKER_FUNCTIONS.find((name) => name === member.member);
}

/**
 * The names of all site-producing facade members (the world-read members plus `ask`). A **bare name** list, usable only
 * for the two-stage decision "take candidates by name first, then verify identity by declaration" — never on its own as an
 * identity basis (see the top of this module).
 *
 * Once `git.log` landed, this set **contains `"log"`**, while the top-level `log()` produces no site. That is not a
 * contradiction but the proof of why this list can only serve as a candidate key: identity has to come from (container, member)
 * or from resolving the declaration; the name itself cannot answer. The only property still relied upon is
 * **that no two facade containers declare a member of the same name** — the set carries no container, and a
 * duplicate name would make the name looked up through it ambiguous (the facade-misuse diagnostic text quotes it).
 */
export const SITE_MEMBER_NAMES: ReadonlySet<string> = new Set<string>([
  ASK_MEMBER.member,
  ...WORLD_READ_REGISTRY.map((row) => row.member),
  ...ARTIFACT_REGISTRY.map((row) => row.member),
]);

/**
 * Registry lookup: (container, member) -> op. It never hits when the container is undefined (a top-level function) — a
 * world-read always hangs on a facade container object.
 */
function worldReadOp(container: string | undefined, member: string): WorldReadOp | undefined {
  if (container === undefined) return undefined;
  return WORLD_READ_REGISTRY.find((row) => row.container === container && row.member === member)
    ?.op;
}

/**
 * Whether (container, member) is a site-producing facade call (a world-read, an artifact, `Agent.ask`, or the top-level
 * `agent`/`report`).
 *
 * The artifact members are in here for the same reason as `report`: they have journal keys (`artifact#N` x ordinal),
 * and a publish without a site is a journal row without a key — exactly what the facade-siting rule prevents.
 */
export function isSiteProducing(container: string | undefined, member: string): boolean {
  if (container === undefined) return SITE_PRODUCING_FUNCTIONS.some((name) => name === member);
  if (container === ASK_MEMBER.container && member === ASK_MEMBER.member) return true;
  if (artifactRow(container, member) !== undefined) return true;
  return worldReadOp(container, member) !== undefined;
}

/**
 * The **container name** a facade declaration belongs to: the `glob` of `declare const files: { glob(...) }` -> `"files"`, the
 * `ask` of `declare interface Agent { ask(...) }` -> `"Agent"`, a top-level `declare function agent()` ->
 * undefined (no container).
 *
 * Implementation: a member's declaration is a method/property signature inside a type literal or an interface body, and from
 * there one walks up to the VariableDeclaration (a const container) or the InterfaceDeclaration / TypeAliasDeclaration (a
 * named type container) to take its name. Only declarations landing inside the facade `.d.ts` count — a same-named member the
 * script defines itself is always undefined.
 */
export function facadeContainerOf(declaration: ts.Node | undefined): string | undefined {
  if (declaration === undefined) return undefined;
  if (declaration.getSourceFile().fileName !== FACADE_FILE_NAME) return undefined;
  for (let node: ts.Node | undefined = declaration.parent; node !== undefined; node = node.parent) {
    if (ts.isVariableDeclaration(node)) {
      return ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name.text;
    if (ts.isSourceFile(node)) return undefined;
  }
  return undefined;
}

/**
 * The (container, member) identity of a facade symbol. A hit is any declaration of the symbol landing inside the facade
 * `.d.ts`; the container is resolved by walking up from that declaration (a top-level facade function has no
 * container). A non-facade symbol -> undefined.
 */
function facadeMemberOf(
  symbol: ts.Symbol | undefined,
): { container: string | undefined; member: string } | undefined {
  const declaration = symbol?.declarations?.find(
    (decl) => decl.getSourceFile().fileName === FACADE_FILE_NAME,
  );
  if (declaration === undefined || symbol === undefined) return undefined;
  return { container: facadeContainerOf(declaration), member: symbol.name };
}

/** The world-read op a certain facade symbol resolves to (decided by the declaring container); undefined when it is not a world-read. */
export function worldReadOpOfSymbol(symbol: ts.Symbol | undefined): WorldReadOp | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return worldReadOp(member.container, member.member);
}
