/**
 * `@zcode/rust/subagent-profile` — the Rust owner of agent-profile parsing.
 *
 * Spec: `docs/specs/subagent-rust-port.md` (Phase 1).
 *
 * There is **no JavaScript fallback** (`packages/rust/src/loader.ts`, invariant 1). The
 * TypeScript parser this replaces is deleted rather than disabled: a profile that parses
 * in Rust on one run and in TypeScript on the next would make the yield contract depend on
 * which binary happened to be staged — and a dropped `outputSchema` fails *silently*,
 * turning a declared contract into an unenforced one.
 *
 * `parseAgentProfileFromMarkdown` is a pure function, so the boundary is one JSON string in
 * and one JSON string out; no types are redeclared here, because that would be a second
 * source of truth for the same contract.
 */
import { loadNative } from "./loader.js";

/** Mirrors `AgentProfileSource`. */
export type AgentProfileSource = "built-in" | "project" | "user";

/** Mirrors `AgentProfileParseDiagnostic`. */
export interface AgentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

/** Mirrors the yielded-result contract carried on `AgentProfile.yield`. */
export interface AgentProfileYieldContract {
  mode: "structured";
  schema: unknown;
}

/** Mirrors `AgentProfile`. Every field is declared because the shape is a wire contract. */
export interface NativeAgentProfile {
  /** The parsed frontmatter map, verbatim. */
  frontmatter: Record<string, unknown>;
  name: string;
  description: string;
  source: AgentProfileSource;
  systemPrompt: string;
  path?: string;
  color?: string;
  permissionMode?: string;
  maxTurns?: number;
  memory?: string;
  yield?: AgentProfileYieldContract;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  background?: boolean;
  injectAgentsMd?: boolean;
  mcpServers?: string[];
}

/**
 * The parse result. `diagnostic` is the back-compat single slot and always equals
 * `diagnostics[0]`; the array exists because one profile can carry more than one problem.
 */
export interface NativeAgentProfileParseOutcome {
  diagnostic: AgentProfileParseDiagnostic | null;
  diagnostics: AgentProfileParseDiagnostic[] | null;
  profile: NativeAgentProfile | null;
}

interface NativeSubagentProfileModule {
  /** Synchronous: this parses one markdown document and touches no I/O. */
  parseProfileJson(content: string, source: string, path?: string): string;
}

let cached: NativeSubagentProfileModule | null = null;

function module(): NativeSubagentProfileModule {
  cached ??= loadNative<NativeSubagentProfileModule>("zcode-subagent-profile");
  return cached;
}

/**
 * Parse one agent profile. Throws when the native binary is missing — loudly, because a
 * silently skipped profile would remove the agent from the parent's tool list without
 * saying why.
 */
export function parseAgentProfileFromMarkdown(input: {
  content: string;
  path?: string;
  source: AgentProfileSource;
}): NativeAgentProfileParseOutcome {
  const raw = module().parseProfileJson(input.content, input.source, input.path);
  return JSON.parse(raw) as NativeAgentProfileParseOutcome;
}

/**
 * Agent artifact documents and writes.
 *
 * Spec: `docs/specs/subagent-rust-port.md` (Phase 2). Byte-parity with the TypeScript
 * implementation it replaces is pinned by `metadata-golden.json`.
 */

/** Mirrors `MetadataInput` on the Rust side. Omitted keys stay omitted. */
export interface AgentMetadataInput {
  agentId: string;
  childSessionId: string;
  createdAt: string;
  cwd?: string;
  description?: string;
  metadataFile: string;
  outputFile: string;
  parentSessionId?: string;
  parentToolUseId?: string;
  profileId?: string;
  profileSnapshot?: unknown;
  prompt?: string;
  status: string;
  taskOutputFile: string;
  updatedAt: string;
  workspaceRoot?: string;
  extra?: Record<string, unknown>;
}

/** Mirrors `ArtifactWrite`. */
export interface AgentArtifactWrite {
  metadataFile: string;
  outputFile: string;
  taskOutputFile: string;
  outputText: string;
  metadata: AgentMetadataInput;
  /** When present, also written to `<outputFile>.structured.json`. */
  structured?: unknown;
}

interface NativeArtifactModule {
  buildMetadataDocumentJson(metadataJson: string): string;
  writeAgentArtifactsJson(requestJson: string): string;
}

let cachedArtifacts: NativeArtifactModule | null = null;

function artifactModule(): NativeArtifactModule {
  cachedArtifacts ??= loadNative<NativeArtifactModule>("zcode-subagent-profile");
  return cachedArtifacts;
}

/** The metadata document as bytes: 2-space indent, trailing newline. */
export function buildAgentMetadataDocument(input: AgentMetadataInput): string {
  return artifactModule().buildMetadataDocumentJson(JSON.stringify(input));
}

/**
 * Write the subagent artifacts and return the paths written, in order.
 * Throws on any I/O failure — a half-written artifact set is worse than none, because
 * the next run would read a `metadata.json` that claims a status it never reached.
 */
export function writeAgentArtifacts(input: AgentArtifactWrite): string[] {
  const raw = artifactModule().writeAgentArtifactsJson(JSON.stringify(input));
  return JSON.parse(raw) as string[];
}

/** Mirrors `LifecyclePaths`. */
export interface SubagentLifecyclePaths {
  agentOutputDir: string;
  metadataFile: string;
  outputFile: string;
  taskOutputFile: string;
}

interface NativeLifecycleModule {
  deriveLifecyclePathsJson(requestJson: string): string;
}

let cachedLifecycle: NativeLifecycleModule | null = null;

function lifecycleModule(): NativeLifecycleModule {
  cachedLifecycle ??= loadNative<NativeLifecycleModule>("zcode-subagent-profile");
  return cachedLifecycle;
}

/**
 * The artifact paths for one subagent run.
 *
 * Spec: `docs/specs/subagent-rust-port.md` (Phase 2). Joining is Node-compatible —
 * `std::path` does not collapse `..`, and a path with a literal `..` would resolve to a
 * different directory than the one recorded in `metadata.json`. `nodepath-golden.json`
 * pins the behaviour against Node's own `path.join`.
 *
 * `recordedOutputFile` wins when present: a resumed run must keep writing into the
 * directory its first run used.
 */
export function deriveLifecyclePaths(input: {
  outputRootDir?: string;
  sessionId: string;
  agentId: string;
  recordedOutputFile?: string;
}): SubagentLifecyclePaths {
  const request = {
    outputRootDir: input.outputRootDir ?? null,
    sessionId: input.sessionId,
    agentId: input.agentId,
    recordedOutputFile: input.recordedOutputFile ?? null,
  };
  return JSON.parse(
    lifecycleModule().deriveLifecyclePathsJson(JSON.stringify(request)),
  ) as SubagentLifecyclePaths;
}

/** Mirrors `MirrorContext`. */
export interface SubagentMirrorContext {
  agentId: string;
  agentType: string;
  childSessionId: string;
  parentSessionId: string;
  parentToolCallId?: string;
  parentTurnId?: string;
  description?: string;
  background: boolean;
}

/**
 * A long-lived mirror for one child run.
 *
 * The tool-name cache lives HERE, in one object, instead of being threaded through call
 * sites as a `Map`. The child emits `tool_call_scheduled` with a name and
 * `tool_call_started` without one; the mirror has to remember. One instance per child
 * run means no shared mutable state and no risk of one run's names leaking into another.
 */
export interface SubagentEventMirror {
  /** The mirrored event, or `undefined` when the event is not mirrored. */
  mirror(event: unknown): unknown | undefined;
}

interface NativeMirrorModule {
  mirrorSubagentToolEventJson(requestJson: string): string;
}

let cachedMirror: NativeMirrorModule | null = null;

function mirrorModule(): NativeMirrorModule {
  cachedMirror ??= loadNative<NativeMirrorModule>("zcode-subagent-profile");
  return cachedMirror;
}

export function createSubagentEventMirror(context: SubagentMirrorContext): SubagentEventMirror {
  const base = {
    agentId: context.agentId,
    agentType: context.agentType,
    childSessionId: context.childSessionId,
    parentSessionId: context.parentSessionId,
    parentToolCallId: context.parentToolCallId ?? null,
    parentTurnId: context.parentTurnId ?? null,
    description: context.description ?? null,
    background: context.background,
  };
  // Owned here and replaced after every event, which is how the cache survives.
  let toolNames: Record<string, unknown> = {};
  return {
    mirror(event: unknown): unknown | undefined {
      const raw = mirrorModule().mirrorSubagentToolEventJson(
        JSON.stringify({ event, context: base, toolNames }),
      );
      const parsed = JSON.parse(raw) as { event: unknown | null; toolNames: Record<string, unknown> };
      toolNames = parsed.toolNames;
      return parsed.event ?? undefined;
    },
  };
}

interface NativeOriginModule {
  buildInteractionOriginJson(contextJson: string, childTurnId?: string): string;
}

let cachedOrigin: NativeOriginModule | null = null;

function originModule(): NativeOriginModule {
  cachedOrigin ??= loadNative<NativeOriginModule>("zcode-subagent-profile");
  return cachedOrigin;
}

/**
 * The interaction origin for a subagent-raised request.
 *
 * Replaces `subagent/interaction-origin.ts`. The mirror builds the identical object when
 * it forwards `permission_requested`, so both call sites now read from one owner.
 */
export function buildSubagentInteractionOrigin(
  context: SubagentMirrorContext,
  childTurnId?: string,
): unknown {
  return JSON.parse(
    originModule().buildInteractionOriginJson(
      JSON.stringify({
        agentId: context.agentId,
        agentType: context.agentType,
        childSessionId: context.childSessionId,
        parentSessionId: context.parentSessionId,
        parentToolCallId: context.parentToolCallId ?? null,
        parentTurnId: context.parentTurnId ?? null,
        description: context.description ?? null,
        background: context.background,
      }),
      childTurnId,
    ),
  );
}

interface NativeCancellationModule {
  selectTasksToCancelJson(tasksJson: string): string;
  shouldSealBackgroundTaskNotificationsJson(taskType: string): boolean;
}

let cachedCancellation: NativeCancellationModule | null = null;

function cancellationModule(): NativeCancellationModule {
  cachedCancellation ??= loadNative<NativeCancellationModule>("zcode-subagent-profile");
  return cachedCancellation;
}

/**
 * Which background tasks a subagent teardown must stop.
 *
 * The rule is Rust; the stopping stays in TypeScript (it goes through the scheduler and
 * the task index). One owner for the predicate — two copies would let a cancelled run
 * leave a stray process behind.
 */
export function selectTasksToCancel(tasks: readonly unknown[]): string[] {
  return JSON.parse(cancellationModule().selectTasksToCancelJson(JSON.stringify(tasks))) as string[];
}

/** Only a subagent child seals background-task notifications. */
export function shouldSealBackgroundTaskNotifications(taskType: string): boolean {
  return cancellationModule().shouldSealBackgroundTaskNotificationsJson(taskType);
}

interface NativeGitFlagsModule {
  hasDangerousGitGlobalOptionJson(argvJson: string): boolean;
  hasDangerousGitGlobalOptionWordJson(word: string): boolean;
}

let cachedGitFlags: NativeGitFlagsModule | null = null;

function gitFlagsModule(): NativeGitFlagsModule {
  cachedGitFlags ??= loadNative<NativeGitFlagsModule>("zcode-subagent-profile");
  return cachedGitFlags;
}

/**
 * Does this git argv name a global option that redirects git elsewhere?
 *
 * A SECURITY BOUNDARY, not a lint. `git -c core.pager=<command>` runs an arbitrary
 * command while every later policy check still sees only `git <subcommand>`; if this
 * returned false for it, the command would be classified read-only and run without
 * asking. Owned by Rust (`docs/specs/subagent-rust-port.md` Phase 3) so there is one
 * implementation of the rule; `git-global-flag-golden.json` pins it.
 */
export function hasDangerousGitGlobalOption(argv: readonly string[]): boolean {
  return gitFlagsModule().hasDangerousGitGlobalOptionJson(JSON.stringify(argv));
}

/**
 * The single-word form of the gate.
 *
 * `normalizeGitArgv` needs this and must NOT reimplement the predicate — a second copy
 * of a security rule is how the two drift.
 */
export function hasDangerousGitGlobalOptionWord(word: string): boolean {
  return gitFlagsModule().hasDangerousGitGlobalOptionWordJson(word);
}

/** Mirrors `SafeFlagValue`. */
export type SafeFlagValueKind =
  | "{}"
  | "EOF"
  | "char"
  | "none"
  | "number"
  | "optionalString"
  | "string";

/** Mirrors `BashReadonlyCommandPolicy`. */
export interface ReadonlyCommandPolicy {
  additionalCommandIsDangerousCallback?: unknown;
  allowAnyArgs?: boolean;
  allowCompactNumericCountFlag?: boolean;
  commandOnly?: boolean;
  regex?: unknown;
  respectsDoubleDash?: boolean;
  /**
   * Absent and `{}` are DIFFERENT: `if (policy.safeFlags)` is truthy for an empty
   * object, so `{}` still goes through the flag walker. Collapsing them rejects
   * `head -20` under an intentionally empty table.
   */
  safeFlags?: Record<string, SafeFlagValueKind>;
}

interface NativeArgvPolicyModule {
  isArgvAllowedByPolicyJson(requestJson: string): boolean;
}

let cachedArgvPolicy: NativeArgvPolicyModule | null = null;

function argvPolicyModule(): NativeArgvPolicyModule {
  cachedArgvPolicy ??= loadNative<NativeArgvPolicyModule>("zcode-subagent-profile");
  return cachedArgvPolicy;
}

/**
 * Are all flags on this argv safe for a read-only command?
 *
 * The permissive direction is the dangerous one: a write flag riding through on a
 * read-only command (`git log --output=/etc/x`, `sed -i`) runs without permission. An
 * unrecognised flag is rejected, never assumed safe. Owned by Rust
 * (`docs/specs/subagent-rust-port.md` Phase 3); `argv-flag-policy-golden.json` pins all
 * 42 cases including the write-flag rejections.
 */
export function isArgvAllowedByPolicy(
  argv: readonly string[],
  policy: ReadonlyCommandPolicy,
  commandName: string,
  startIndex = 1,
): boolean {
  return argvPolicyModule().isArgvAllowedByPolicyJson(
    JSON.stringify({ argv, policy, commandName, startIndex }),
  );
}

/** The danger callbacks Rust owns. */
export type ReadonlyDangerCallbackName =
  | "date"
  | "gitBranch"
  | "gitLsRemote"
  | "gitReflog"
  | "gitRemote"
  | "gitRemoteShow"
  | "gitRevisionFormat"
  | "gitTag"
  | "gh"
  | "jq"
  | "lsof"
  | "man"
  | "ps"
  | "pyright"
  | "sed"
  | "ss"
  | "test"
  | "tput"
  | "xargs";

interface NativeCallbacksModule {
  readonlyCallbackIsDangerousJson(name: string, argsJson: string): boolean;
  isSedInPlaceOptionJson(word: string): boolean;
}

let cachedCallbacks: NativeCallbacksModule | null = null;

function callbacksModule(): NativeCallbacksModule {
  cachedCallbacks ??= loadNative<NativeCallbacksModule>("zcode-subagent-profile");
  return cachedCallbacks;
}

/**
 * Does this "read-only" command actually write?
 *
 * `sed -i` rewrites the file, `sed 'w out'` writes it, `date FILE` writes it, `jq --rawfile`
 * reads an arbitrary path, `lsof -i @host` reaches a remote host. Wrong in the permissive
 * direction and a write runs with no permission prompt, so the default is reject.
 *
 * Owned by Rust (`docs/specs/subagent-rust-port.md` Phase 3);
 * `readonly-callbacks-golden.json` pins 53 cases across the seven callbacks.
 */
export function readonlyCallbackIsDangerous(
  name: ReadonlyDangerCallbackName,
  args: readonly string[],
): boolean {
  return callbacksModule().readonlyCallbackIsDangerousJson(name, JSON.stringify(args));
}
/**
 * `-i`, `--in-place`, or `--in-place=SUFFIX` — sed rewrites the file.
 *
 * Lives in Rust so the `sed` callback and `hasKnownBashWriteOption` cannot disagree about
 * what counts as in-place.
 */
export function isSedInPlaceOption(word: string): boolean {
  return callbacksModule().isSedInPlaceOptionJson(word);
}

/** Mirrors `BashRuleEvaluationInput`. */
export interface BashRuleEvaluationInput {
  allSubjectGroups: readonly (readonly string[])[];
  behavior: "allow" | "deny" | "ask";
  exactCommands: readonly string[];
  requiredSubjectGroups: readonly (readonly string[])[];
  rules: readonly { toolName: string; ruleContent?: string }[];
  safe: boolean;
}

interface NativeRuleMatcherModule {
  evaluateBashRulesJson(requestJson: string): boolean;
}

let cachedRuleMatcher: NativeRuleMatcherModule | null = null;

function ruleMatcherModule(): NativeRuleMatcherModule {
  cachedRuleMatcher ??= loadNative<NativeRuleMatcherModule>("zcode-subagent-profile");
  return cachedRuleMatcher;
}

/**
 * Does a saved permission rule (allow / deny / ask) cover this command?
 *
 * The permission decision itself. Too eager and an `allow` rule covers a destructive
 * command; too loose and a saved `deny` stops firing. Owned by Rust
 * (`docs/specs/subagent-rust-port.md` Phase 3); `bash-rules-golden.json` pins all 18 cases
 * plus the wildcard grammar.
 */
export function evaluateBashRules(input: BashRuleEvaluationInput): boolean {
  return ruleMatcherModule().evaluateBashRulesJson(JSON.stringify(input));
}

/** The read-only policy table, owned by Rust. */
export interface ReadonlyPolicyLookup {
  allowAnyArgs: boolean;
  commandOnly: boolean;
  allowCompactNumericCountFlag: boolean;
  respectsDoubleDash: boolean;
  /** Flag name to `SafeFlagValue`, lower-cased as the Rust debug rendering. */
  safeFlags: Record<string, string>;
  /** The dispatch NAME of the danger callback, not a function reference. */
  additionalCommandIsDangerousCallback?: string;
}

interface NativeTablesModule {
  lookupReadonlyPolicyJson(prefix: string): string | null;
  matchesHostnameJson(text: string): boolean;
}

let cachedTables: NativeTablesModule | null = null;

function tablesModule(): NativeTablesModule {
  cachedTables ??= loadNative<NativeTablesModule>("zcode-subagent-profile");
  return cachedTables;
}

/**
 * The read-only policy for a command prefix, or `undefined` when it is not on the list.
 *
 * The whole table is Rust data — embedded from `readonly-tables-golden.json`, which
 * `scripts/capture-readonly-tables-golden.ts` captures from the live tables — so there is no
 * hand-transcribed copy to drift.
 */
export function lookupReadonlyPolicy(prefix: string): ReadonlyPolicyLookup | undefined {
  const raw = tablesModule().lookupReadonlyPolicyJson(prefix);
  return raw === null ? undefined : (JSON.parse(raw) as ReadonlyPolicyLookup);
}

/**
 * The table's one `RegExp`, written out in Rust because the workspace has no `regex`
 * dependency: `^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$`.
 */
export function matchesHostnameRegex(text: string): boolean {
  return tablesModule().matchesHostnameJson(text);
}

/** The parsed-invocation fields the read-only policy reads. */
export interface ReadonlyPolicyInvocation {
  argv: readonly string[];
  commandText: string;
  envAssignments?: readonly ({ name?: string } | undefined)[];
  redirects?: readonly { operator: string; target: string }[];
}

interface NativeReadonlyPolicyModule {
  evaluateBashReadonlyPolicyJson(requestJson: string): string;
  hasKnownBashWriteOptionJson(argvJson: string): boolean;
}

let cachedReadonlyPolicy: NativeReadonlyPolicyModule | null = null;

function readonlyPolicyModule(): NativeReadonlyPolicyModule {
  cachedReadonlyPolicy ??= loadNative<NativeReadonlyPolicyModule>("zcode-subagent-profile");
  return cachedReadonlyPolicy;
}

/**
 * Is this one parsed command read-only? `undefined` means **no opinion** — the caller keeps
 * evaluating the rest of the line.
 *
 * The decision lives in Rust (`docs/specs/subagent-rust-port.md` Phase 3); only the grammar
 * parse that produces the invocation stays in TypeScript.
 */
export function evaluateBashReadonlyPolicy(
  invocation: ReadonlyPolicyInvocation,
): boolean | undefined {
  const raw = readonlyPolicyModule().evaluateBashReadonlyPolicyJson(
    JSON.stringify({
      argv: invocation.argv,
      commandText: invocation.commandText,
      envAssignments: (invocation.envAssignments ?? []).map((item) =>
        item === undefined ? null : { name: item.name },
      ),
      redirects: invocation.redirects ?? [],
    }),
  );
  return raw === "null" ? undefined : raw === "true";
}

/**
 * Does this argv carry a KNOWN write option (`sed -i`, `find -delete`, `tree -o`, a dangerous
 * git global)? Distinct from "not read-only": an unknown command has no write option AND is
 * not read-only, and the permission flow treats those differently.
 */
export function hasKnownBashWriteOption(argv: readonly string[]): boolean {
  return readonlyPolicyModule().hasKnownBashWriteOptionJson(JSON.stringify(argv));
}

interface NativeGitRuntimeSafetyModule {
  isGitRuntimeContextUnsafeJson(workingDirectory: string | null): boolean;
  analysisGitPredicatesJson(namesJson: string): string;
}

let cachedGitRuntimeSafety: NativeGitRuntimeSafetyModule | null = null;

function gitRuntimeSafetyModule(): NativeGitRuntimeSafetyModule {
  cachedGitRuntimeSafety ??= loadNative<NativeGitRuntimeSafetyModule>("zcode-subagent-profile");
  return cachedGitRuntimeSafety;
}

/**
 * Is this working directory safe to run a read-only git command in?
 *
 * Inspects `.git`: a symlinked one, a `gitdir:` file pointing outside the workspace, a bare
 * layout, or a path that cannot be resolved — all reported UNSAFE. Git loads hooks and config
 * from the directory it runs in, so a wrong answer here means git executes somewhere the policy
 * did not expect.
 */
export function isGitRuntimeContextUnsafe(
  context: { workingDirectory?: string } | undefined,
): boolean {
  return gitRuntimeSafetyModule().isGitRuntimeContextUnsafeJson(
    context?.workingDirectory ?? null,
  );
}

/**
 * `hasGit` / `hasGitAndDirectoryChange` for a parsed command line.
 *
 * Takes each command's ARGV, not its reported name: the grammar reports `command`/`builtin`/
 * `noglob` as the name, so unwrapping has to happen somewhere — it happens here, once.
 */
export function analysisGitPredicates(
  commands: readonly { argv: readonly string[] }[],
): { hasGit: boolean; hasGitAndDirectoryChange: boolean } {
  return JSON.parse(
    gitRuntimeSafetyModule().analysisGitPredicatesJson(JSON.stringify(commands.map((c) => c.argv))),
  ) as { hasGit: boolean; hasGitAndDirectoryChange: boolean };
}
