/**
 * The dynamic-workflow facade: the entire model-facing API surface, shipped as an
 * embedded .d.ts asset (same pattern as SCRIPT_WORKFLOW_CHILD_SOURCE) so the compiler
 * works inside the bundled/SEA CLI where no node_modules exists on disk.
 *
 * One noun (the actor), one verb
 * (the task). Runtime shims are injected by the runtime layer, never imported.
 *
 * Sectioned organization: the facade is split into named section constants, and both `FACADE_DTS` and `SNIPPET_FACADE_DTS`
 * are **assembled** from those sections — a single source of truth, with the subset never hand-copied.
 * The assembled result is byte-for-byte identical to the `FACADE_DTS` of before the split. Each section
 * starts and ends with a single newline, so concatenating sections naturally reproduces the original blank-line separation.
 */

export const FACADE_FILE_NAME = "workflow-facade.d.ts";

/** The actor family: Node / AgentPersona / Agent / agent(). Deliberately absent from the snippet. */
const FACADE_ACTOR_SEGMENT = String.raw`
/**
 * A node: one task assigned to an actor, producing a typed result.
 * Thenable — await it, or combine with Promise.all for joins.
 */
declare interface Node<T> extends PromiseLike<T> {}

/**
 * Persona of an actor: identity, fixed at creation (frozen for the actor's lifetime). Every
 * actor has the regular working tools (reading, searching, editing, running commands); what
 * it may do with them is said in the ask.
 */
declare interface AgentPersona {
  /** System prompt describing the actor's role. */
  system?: string;
}

/**
 * An actor: a persistent conversational context that executes tasks serially.
 * Context accumulates across asks; concurrent asks on one actor queue FIFO.
 */
declare interface Agent {
  /**
   * Assign one task. T is the task's output value: an interface you define in
   * this script with a plain "interface" declaration (no "declare" modifier; the
   * harness synthesizes its runtime schema from the type), or the final response
   * text when the type argument is omitted.
   */
  ask<T = string>(instructions: string): Node<T>;
}

/**
 * Create a fresh actor. Every call creates a new context; sharing context means
 * sharing this reference.
 *
 * The name is optional, but a non-empty one is an identity, not a label. It must be
 * unique within the run: two actors under the same name fail the whole run. It is
 * also the key a revised re-run matches its cache on (AmendWorkflow imports the
 * finished work of each named actor), so stable, meaningful
 * names carry work across script revisions. Anonymous actors are legal and never
 * reuse imported work.
 *
 * In a fan-out or a loop each iteration is a separate actor, so a single static name
 * there is the duplicate case: give each one its own name (agent("reviewer-" + file))
 * or leave them all anonymous. A literal name in a loop is reported when the script
 * is compiled; a computed one fails at run time.
 */
declare function agent(name?: string, persona?: string | AgentPersona): Agent;
`;

/** Progress narration: log(). Present in both facades. */
const FACADE_LOG_SEGMENT = String.raw`
/** Emit a progress message to the user. */
declare function log(message: string): void;
`;

/** Incremental artifacts: report(). Journaled, shown in the run panel's Results section; deliberately absent from the snippet. */
const FACADE_REPORT_SEGMENT = String.raw`
/**
 * Publish one intermediate result while the run is still going. Like log() it
 * returns nothing and there is nothing to await — a finding has no reply.
 *
 * Unlike log() it is journaled: a resumed run never shows the same item twice, and
 * the items are delivered with the completion notification even when the run ends in
 * failure. That is the point of it — a run that dies on its twelfth of forty tasks
 * still did eleven tasks' worth of work, and reported items are how that work
 * survives.
 *
 * Two caps, and both fail the whole run rather than the call (there is no rejection
 * channel in a void return): at most 256 items per run, and at most 32KB per
 * serialized item. They are generous on purpose — report findings, not chatter.
 *
 * The item must be JSON-serializable: plain objects, arrays, strings, numbers,
 * booleans, null. Functions, class instances, Date and promises are rejected when
 * the script is compiled.
 *
 * The optional second argument routes the item to a dashboard artifact: pass the id
 * of a preset declared with artifact.chart / table / metrics / board, and this item
 * becomes one more point, row, tile value or card on it — the dashboard is nothing
 * but the items tagged with its id. The tag must be a compile-time string literal
 * naming a preset the script declares (anywhere in the text, but the declaration must
 * have executed by the time this call runs); a tag that names nothing, or names a
 * file/markdown artifact, fails the run. An untagged report is unchanged: it goes to
 * the run's Results, and a tagged one goes to both.
 */
declare function report(item: unknown, artifactId?: string): void;
`;

/**
 * Artifacts: artifact.*. What the script hands to the **user** — The content members (`file` / `markdown`) are effects, the preset members (`chart` /
 * `table` / `metrics` / `board`) are declarations. Deliberately absent from the snippet: a snippet is a
 * workbench of world reads plus pure logic with no run to hang a deliverable on, so
 * `artifact.file(...)` in a snippet yields TS2304, teaching deletion (the same stance as for `agent` / `report`).
 *
 * ⚠ Terminology: every artifact in this section is a **user-facing artifact**; the engine-internal artifact of the same name (the top-level
 * return value / a site's typed output) is the T of `Node<T>` on the facade, and the two are unrelated.
 */
const FACADE_ARTIFACT_SEGMENT = String.raw`
/** A published artifact version: the id it was published under, and which version this call minted. */
declare interface ArtifactRef { id: string; version: number }
/** Card metadata every artifact kind accepts. */
declare interface ArtifactOptions {
  /** Shown as the card title; defaults to the id. In the user's language. */
  title?: string;
  /** A sentence or two, shown beside the title when this artifact leads the card. */
  description?: string;
  /** The run's deliverable: the card and the run pane lead with it. At most one id per run; once set it stays set for later versions. */
  primary?: boolean;
}
declare interface ArtifactFileOptions extends ArtifactOptions {
  /** Overrides the type sniffed from the extension ("application/pdf", "text/html", …). */
  contentType?: string;
}
/** One value taken from a reported item: a dot path into the item ("timing.after"). */
declare interface ArtifactField { field: string; label?: string; unit?: string }
declare interface ChartSpec extends ArtifactOptions {
  type?: "line" | "bar" | "scatter";        // default "line"
  x: ArtifactField;
  y: ArtifactField | ArtifactField[];        // several = several series
  scale?: "linear" | "log";                  // y axis, default "linear"
  /** A reference value drawn as a horizontal rule, taken from the first item that has the field. */
  baseline?: ArtifactField;
}
declare interface TableSpec extends ArtifactOptions {
  columns: ArtifactField[];
  /** Field that identifies a row; a later item with the same key replaces the row. Absent = append-only. */
  key?: string;
}
declare interface MetricsSpec extends ArtifactOptions {
  /** Each tile shows the value from the latest item that has the field. */
  metrics: ArtifactField[];
}
declare interface BoardSpec extends ArtifactOptions {
  /** Field identifying a card; a later item with the same key moves/updates the card. */
  key: string;
  /** Field holding the card's column. */
  status: string;
  /** Column order. Items whose status is not listed land in a trailing "other" column. */
  columns: string[];
  /** Field for the card title (default: the key) and extra fields shown on the card. */
  cardTitle?: string;
  detail?: ArtifactField[];
}
/**
 * Publish what the user should see: the run's own deliverable surface, kept after it ends.
 * Two habits. (1) EVERY RUN PUBLISHES ITS DELIVERABLE, whatever the user asked for: a webpage
 * or PDF a subagent wrote goes out via file(); an answer (findings, a review) goes out as the
 * long form of the facts the return summarises, usually via markdown(). Once, at the end;
 * skip it only when the whole answer is one line. When the run publishes more than one
 * artifact, mark the deliverable { primary: true }. (2) A DASHBOARD IS FOR THE PERSON WATCHING
 * THE RUN: declare one when there is state worth watching mid-run (the key number per round,
 * which items are done) and none when the run is over before anyone looks. Two tests keep it
 * to what matters: would the user open it on its own? does it repeat another artifact? A CSV
 * and a table of its rows: one of them is noise.
 *
 * Every id is a compile-time string literal (non-empty, at most 64 characters of
 * [A-Za-z0-9_.-]); the set a run can publish is fixed at submit time, so the compiler
 * rejects a computed one. Within one run an id belongs to exactly one member.
 * The two families are deliberately asymmetric, and the asymmetry is the whole design:
 * - CONTENT (file, markdown) are EFFECTS: async, resolve to an ArtifactRef, and REJECT
 *   catchably — missing file, not a file, path outside the workspace, over the size cap, no
 *   store. try { await artifact.file("book", "out/book.pdf") } catch { …ask a subagent to
 *   write it… } is the intended idiom. Bytes are copied at publish time, so later workspace
 *   edits never rewrite a version; republishing an id mints the NEXT version and keeps the
 *   old ones (at most 16 per id).
 * - PRESET (chart, table, metrics, board) are DECLARATIONS: synchronous, return nothing,
 *   never touch a file; they say how items tagged with their id are drawn. Declare each ONCE,
 *   at the top, then feed it with report(item, "<id>"). The same id with an identical spec is
 *   a no-op; a DIFFERENT or malformed spec fails the whole run — a void return has no
 *   rejection channel, exactly as with report().
 * Caps: 32 ids per run, 16 versions per id, 20 MiB per file, 256 KB per markdown, 120
 * characters of title and 500 of description.
 */
declare const artifact: {
  /**
   * Publish a file from the workspace. path is workspace-relative, resolved by the same
   * resolver files.read() uses; the bytes are copied at publish time. The content type is
   * read off the extension unless opts.contentType overrides it. Rejects (catchably)
   * rather than publishing something empty.
   */
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  /** Publish markdown text the script composed: the usual shape of a report deliverable, the long form of what the return summarises. */
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  /** Declare a chart fed by report(item, id): each tagged item is one point. */
  chart(id: string, spec: ChartSpec): void;
  /** Declare a table fed by report(item, id): each tagged item is one row. */
  table(id: string, spec: TableSpec): void;
  /** Declare a metric tile row fed by report(item, id): each tile shows the newest value it has. */
  metrics(id: string, spec: MetricsSpec): void;
  /** Declare a board fed by report(item, id): each tagged item is a card, placed by its status field. */
  board(id: string, spec: BoardSpec): void;
};
`;

/**
 * Phase markers: phase(). Grouping markers for presentation —
 * no site, no journal row; lowering rewrites them into `__host.enterPhase` and the engine emits a single
 * enter event. Deliberately absent from the snippet: a snippet is a workbench of world reads plus pure logic and
 * draws no graph, so `phase()` in a snippet yields TS2304, teaching deletion.
 */
const FACADE_PHASE_SEGMENT = String.raw`
/**
 * Mark the start of a phase: a short, human-readable name for the group of steps that
 * follow, shown as one node on the workflow graph the user reads and approves.
 * Presentation only — it starts nothing, waits for nothing, returns nothing.
 *
 * Required in every script you submit, not optional: the phase graph is how the user
 * experiences the workflow. Without markers they face one card per step and no story;
 * group the whole script, top to bottom.
 *
 * Name phases for the user, in the language the user is speaking in this session: a short
 * natural phrase saying what the stage accomplishes ("Research each changed file in parallel",
 * "and produce the final report"). Graph-building vocabulary the user never chose — "fan-out", "gate",
 * "aggregate" — is not a name; the user approves stages by what they do. Say it the way you
 * would tell a colleague what is happening: "confirm the tests still pass", not "execute the test verification task".
 *
 * The scope is the rest of the enclosing block: the marker claims every step issued
 * from it to the end of the block it stands in — nested blocks and inlined helper
 * calls included — and the enclosing phase resumes once that block ends. A marker
 * inside an if-branch therefore groups that branch and does not leak past it. Two
 * markers with the same name are one phase: repeating a name continues that phase,
 * which is the opposite of an actor's name — that one has to be unique.
 *
 * Two rules the compiler enforces. The name must be a compile-time string literal
 * ("review the diff" or a no-substitution template) and non-empty, because the phase
 * names label the graph the user confirms before anything runs. And the call must
 * stand alone as its own statement: a marker in expression position has no
 * rest-of-block to claim.
 *
 * Every phase must contain at least one subagent ask or one world.run. A phase is a
 * stage the user watches progress through; plain script logic between two asks (reading
 * args, shaping a prompt, building the return) runs in a flash and shows no progress, so
 * it is not a stage. Fold it into the phase before or after it; never open a phase for
 * the setup at the top or the return at the bottom.
 *
 * Idiom: one marker at the head of each stage that does work — name the loop body and
 * its check where they start, name the close-out that asks or runs after the loop.
 */
declare function phase(name: string): void;
`;

/** World reads: files.* and git.*. Present in both facades (the fidelity core of the snippet). */
const FACADE_WORLD_SEGMENT = String.raw`
/** One matching line found by files.grep. */
declare interface GrepMatch {
  /** Workspace-relative path of the file the match was found in. */
  path: string;
  /** One-based line number of the match. */
  line: number;
  /** The full text of the matching line. */
  text: string;
}

/**
 * Journaled read-only observations of the workspace, executed by the harness.
 * Replay returns the journal-recorded value. Prefer passing paths to agents and
 * letting them read files with their own tools; read() and grep() are for when the
 * script itself must shard or branch on content. There is no write — writing to the
 * world is an agent task.
 */
declare const files: {
  /**
   * List workspace files matching a glob pattern, as workspace-relative paths sorted
   * lexicographically. Capped at 2000 files: over the cap the call rejects instead of
   * returning a partial view — narrow the pattern.
   */
  glob(pattern: string): Promise<string[]>;
  /** Read one workspace file as UTF-8 text. Size-capped. */
  read(path: string): Promise<string>;
  /**
   * Search file contents with a ripgrep-compatible regular expression, optionally
   * narrowed to a glob over paths (the same syntax glob() takes: "*.ts", "src/**").
   * Returns one entry per matching line, with workspace-relative paths and one-based
   * line numbers.
   *
   * Capped at 2000 matches or 256KB of results, whichever comes first. Over the cap
   * the call rejects instead of returning a partial view — a silently truncated search
   * is the one result you cannot reason about — so narrow the pattern or add a glob.
   */
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};

/** The working tree's status, as reported by git.status(). */
declare interface GitStatus {
  /** Current branch name; absent when HEAD is detached. */
  branch?: string;
  /** True when nothing is staged, modified, or untracked. */
  clean: boolean;
  /** Workspace-relative paths staged for the next commit. */
  staged: string[];
  /** Workspace-relative paths modified in the working tree but not staged. */
  unstaged: string[];
  /** Workspace-relative paths git does not track (honouring .gitignore). */
  untracked: string[];
}

/** One commit, as reported by git.log(). */
declare interface GitCommit {
  /** Full commit hash. */
  hash: string;
  /** First line of the commit message. */
  subject: string;
  /** Author name. */
  author: string;
  /** Author date, ISO 8601. */
  date: string;
}

/**
 * Journaled read-only git observations — the same bargain as files.*: executed by the
 * harness, recorded in the journal, and replayed from the record, so a resumed run
 * sees the repository as it was rather than as it is now.
 *
 * Read-only by construction rather than by permission: the harness builds a fixed
 * argument list for one allowlisted subcommand and never a shell string, so there is
 * no call this surface can express that writes. A base must name a single ref — no
 * ".." ranges in this version — and paths are workspace-relative.
 *
 * Observations are scoped to the workspace, which is the same world files.* observes:
 * every path you get back is relative to the workspace and safe to pass straight to
 * files.read(). If the workspace is a subdirectory of the repository, changes outside
 * it are not reported — the workspace is the world. git.log is the exception, because
 * commits are repository-wide objects rather than paths.
 *
 * Caps reject rather than truncate (diff at 512KB, log at 100 commits), for the same
 * reason grep does. Outside a git repository, or with no git available, every call
 * rejects with a catchable error, so the idiom is try/catch with a files.glob fallback.
 */
declare const git: {
  /**
   * Workspace-relative paths that changed. With no base: files modified against HEAD
   * plus untracked files, because a brand-new file is a change to anyone reading. With
   * a base ref: files differing from that ref, tracked history only.
   */
  changedFiles(base?: string): Promise<string[]>;
  /**
   * Unified diff against base (default HEAD). Covers the whole workspace unless you
   * narrow it to one workspace-relative path.
   */
  diff(base?: string, path?: string): Promise<string>;
  /** The current working-tree status, for the workspace. */
  status(): Promise<GitStatus>;
  /**
   * The most recent commits, newest first. Default 20, maximum 100. Unlike the other
   * members this reads repository-wide history, not workspace paths.
   */
  log(count?: number): Promise<GitCommit[]>;
};
`;

/**
 * Journaled command execution: world.run. Present in both facades
 * — the snippet is exactly the workbench for exercising these calls (the gate logic is proven against real commands before submit).
 */
const FACADE_WORLD_RUN_SEGMENT = String.raw`
/** The outcome of one world.run command, including nonzero exits. */
declare interface WorldRunResult {
  /** The process exit code. Nonzero is a normal, returned outcome — branch on it. */
  exitCode: number;
  /** Captured stdout (UTF-8). Capped at 256KB; over the cap the call rejects. */
  stdout: string;
  /** Captured stderr (UTF-8). Same cap and rejection semantics as stdout. */
  stderr: string;
}

/**
 * Journaled command execution — the effect primitive. Executed by the harness exactly
 * once per call site and iteration, recorded in the journal, and replayed from the
 * record on resume (resume is crash recovery, not re-verification).
 *
 * Deliberately unlike git.*: a completed process with a NONZERO exit code RESOLVES to
 * a WorldRunResult — a failing check is the gating loop's normal case and must not
 * travel exception control flow. The promise only rejects (catchably) when the
 * command could not run as an observation at all: spawn failure, or timeout (default
 * 300000ms, override per call via timeoutMs, no upper cap).
 *
 * cmd must be a compile-time string literal: the script's command set is shown to the
 * user when the run is confirmed, and only those commands are executable. Fixed argv,
 * never a shell — no pipes, no redirection, no variable expansion; compose with
 * multiple calls and plain code. cwd is the workspace. Idiom: model generates, code
 * gates — run the check here, parse its output with pure script logic, and hand
 * failures to an agent to fix. A helper that needs Node builtins can be inlined as
 * world.run("node", ["-e", code]) — the code string lives inside the script, so it is
 * pinned by the journal key like every other argument.
 */
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult>;
};
`;

/** The runtime arguments: the declarative parameters of a saved workflow. Present in both facades (always `{}` in the snippet). */
const FACADE_ARGS_SEGMENT = String.raw`
/**
 * The run's arguments: the values supplied when this workflow was started.
 *
 * A workflow saved into the project declares its arguments (name, type, whether they
 * are required, defaults); the host validates the caller's values against that
 * declaration and fills in defaults before the run starts, so what lands here is
 * always a complete, checked bag. For an inline script — and inside a snippet — it is
 * simply empty.
 *
 * Always defined, so reading args.target is a plain property read rather than a crash.
 * The values are typed unknown on purpose: the compiler surface must not change from
 * one workflow to the next, so narrow them in the script -- String(args.target), or a
 * typeof guard -- exactly as you would any other external input.
 */
declare const args: Readonly<Record<string, unknown>>;
`;

export const FACADE_DTS =
  FACADE_ACTOR_SEGMENT +
  FACADE_ARGS_SEGMENT +
  FACADE_LOG_SEGMENT +
  FACADE_REPORT_SEGMENT +
  FACADE_ARTIFACT_SEGMENT +
  FACADE_PHASE_SEGMENT +
  FACADE_WORLD_SEGMENT +
  FACADE_WORLD_RUN_SEGMENT;

/**
 * The scratch facade of the snippet (EvalWorkflowSnippet): the production facade minus the actor
 * family / report / artifact / phase. What is left is the part
 * of the script that can be unit-tested by itself: world reads + world.run +
 * pure computation + log. `agent(...)` under this facade is an ordinary TS2304
 * (Cannot find name), so the rejection happens at compile time rather than at runtime.
 *
 * When injecting it into the compiler it must still use {@link FACADE_FILE_NAME} as the file name: the facade
 * identity is decided in five places by the declaring file name (registry / sites / facade-misuse / lowering), and
 * changing the name makes the site collection silently come up empty — the snippet compiles and then does nothing.
 */
export const SNIPPET_FACADE_DTS =
  FACADE_ARGS_SEGMENT + FACADE_LOG_SEGMENT + FACADE_WORLD_SEGMENT + FACADE_WORLD_RUN_SEGMENT;
