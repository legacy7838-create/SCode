# Spec: Subagent result contract (omp-style structured yield)

Status: draft — written before implementation, per `AGENTS.md:3`.
Owner: main session.
Upstream reference: `can1357/oh-my-pi` (`packages/coding-agent/src/task/`, `src/tools/yield.ts`).

## 0. Goal in one line

A subagent's report must be a **contract, not prose**: schema-validated, bounded in the parent's
context, and addressable on demand — so a 48 KB worker output costs the parent ~5 KB plus a
pointer, and a malformed report is rejected and retried instead of silently accepted.

## 1. Current behaviour (measured, 2026-10)

`apps/zcode-cli/packages/core/src/tool/handlers/agent.ts:130-165` — what the parent sees today:

```ts
function formatAgentOutputForModel(output: unknown): string {
  const parsed = AgentOutputSchema.safeParse(output);
  if (!parsed.success) return typeof output === "string" ? output : JSON.stringify(output);

  const data = parsed.data as AgentOutput;
  if (data.status !== "async_launched") {
    const childText = data.content.map((block) => block.text).join("\n");   // ← EVERY text block
    const childContent = childText.trim().length > 0
      ? [childText]
      : ["(Subagent completed but returned no output.)"];                     // ← silent no-output
    return [...childContent, `agentId: ${data.agentId} …`, `<usage>…</usage>`].join("\n");
  }
  // async: output_file path is handed over
}
```

Confirmed gaps (grep-verified, no `yield`/`outputSchema`/`schema_violation` anywhere in
`packages/services/src/subagents/` or `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`):

| # | Gap | Consequence |
|---|---|---|
| G1 | No schema on the child's report | A child returning one paragraph passes as "completed" |
| G2 | No size bound on `data.content` | A verbose child can flood the parent context |
| G3 | No retry on malformed report | One bad turn = permanently bad result |
| G4 | `outputFile` only exists on the **async** path | A foreground child's full output has no address |
| G5 | Resume exists (`SendMessage` → `agentId`) but is undiscoverable | The parent is told the id, not that it means "resume" |
| G6 | `(Subagent completed but returned no output.)` | An empty result is indistinguishable from a lost one |

## 2. What upstream does (evidence, for the port decisions)

`omp/packages/coding-agent/src/tools/yield.ts:279` — bounded retry:

```ts
const MAX_SCHEMA_RETRIES = 3;
const MAX_EMPTY_RESULT_RETRIES = 3;
// on failure:
throw new Error(
  `Output does not match schema: ${formatAllValidationIssues(sectionFailure.issues)}.` +
  ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain ` +
  `before the schema constraint is dropped.`);
```

`omp/.../task/yield-assembly.ts` — section shapes drive merge semantics:

> Array-declared properties accumulate into a list even when the agent emits exactly one
> section — otherwise a single `type: ["findings"]` yield would assemble as a bare object and
> fail array-typed validation. Other declared properties are scalar: a repeated yield replaces
> the earlier value instead of assembling an array the schema rejects.

`omp/.../task/result-summary.ts` — the parent's envelope:

```ts
const FULL_OUTPUT_THRESHOLD = 5000;                       // inline preview budget
export function formatTaskResultSummary(result, options) { … }
// → prompts/tools/task-summary.md:
// <task-result id="…" agent="…" status="completed" duration="…">
//   <meta lines="…" size="…" />
//   <preview full-output="agent://{{id}}"> … </preview>
// </task-result>
```

`omp/.../task/executor.ts:676` — finalize turns a yield list into exit code + output:

```ts
export function finalizeSubprocessOutput(args): FinalizeSubprocessOutputResult {
  const hasYield = Array.isArray(yieldItems) && yieldItems.length > 0;
  if (hasYield) {
    const assembled = assembleYieldResult(yieldItems, lastAssistantText, yieldSectionShapes(outputSchema));
    if (!assembled || assembled.missingData) { /* SUBAGENT_WARNING_NULL_YIELD */ }
    else {
      const validation = validator?.validate(completeData);
      if (!validation.success) → buildSchemaViolationOutcome(failure, completeData); // exitCode ≠ 0
      else → rawOutput = JSON.stringify(completeData, null, 2); exitCode = 0;
    }
  }
}
```

`omp/.../prompts/system/subagent-yield-reminder.md` — the nudge ladder (every turn must end in
a tool call; 3 reminders; never fabricate a "forced stop" reason).

## 3. Design decisions

| Question | Decision | Why |
|---|---|---|
| Mandatory or optional? | **Optional per agent**, declared in frontmatter (`yield: true` + `outputSchema`). No frontmatter ⇒ byte-identical behaviour to today. | A hard contract for every existing agent file would break every user-defined agent on upgrade. Upstream is mandatory because every subagent there is spawned by the `task` tool; ZCode's `Agent` tool is also used interactively. |
| Where does the schema live? | Agent profile frontmatter (`subagent/profile.ts`), parsed into `AgentProfile.yield = { mode, schema }`, validated with the **existing** repo JSON-Schema validator (`validateJsonSchemaValue` in `tool/json-schema.ts`, already used by `tool/executor/validation.ts`). | No new validation library; reuses the repo's own path. `toToolJsonSchema` was rejected: it only accepts a zod runtime schema, whereas frontmatter carries raw JSON. |
| Retry lives where? | In the child-side tool call (throw a retryable error), **not** in the executor. | A thrown tool error is already the mechanism ZCode uses to tell a model "fix and retry"; the executor only finalizes what arrived. |
| Size bound enforced where? | At the **parent-facing formatter only** (`formatAgentOutputForModel`). The child's own context is untouched. | The problem is the parent's context window, not the child's. |
| Addressable output scheme? | Reuse the existing `outputFile` path + `agentId`; do **not** invent `agent://` in phase 1. | ZCode already returns `agentId` + `output_file` for async runs. A new virtual FS scheme is a separate, larger piece of work. |
| Backward compat? | `formatAgentOutputForModel` keeps the old branch when the profile declares no schema. | Zero behaviour change for every existing agent. |

**Explicit non-goals for this phase:** worktree isolation, parallel fan-out scheduling, IRC peer
messaging, the Agent Hub, park/revive UI. Those are separate rungs; this one only fixes the
*result contract*.

### 3.1 Authoring format, as built

`outputSchema` must be a **single-line JSON literal** in frontmatter:

```markdown
---
name: reviewer
description: Reviews a diff
yield: true
outputSchema: {"type":"object","required":["verdict","files"],"properties":{"verdict":{"type":"string"},"files":{"type":"array"}}}
---
```

Reason (measured, not assumed): the agent frontmatter parser is the repo's deliberately *loose*
hand-rolled parser (`subagent/profile-frontmatter.ts`), not a YAML implementation. It parses
`key: {json}` on one line into a real object, but a nested multi-line YAML block does **not**
become an object — it silently degrades, which would fail the contract check with a misleading
"missing schema" error. A quoted JSON string is tolerated (it is `JSON.parse`d), but the
single-line literal is the documented form.

### 3.2 Validation is cumulative, not per-call

A child may yield one section per call, so a required key can legitimately arrive in a *later*
call. The Yield tool therefore validates the **merged-so-far** payload, not the single call's
fragment — the same merge rule `finalizeSubagentYield` applies at the end. Validating each
fragment in isolation would reject every partial yield, which is why this is stated explicitly:
the tool and the finalizer share one merge rule, so "accepted by the tool" and "accepted by the
finalizer" cannot disagree.

### 3.3 Tool registration is per-child, never global

`Yield` is **not** part of `builtInTools`, so `registerBuiltInTools` never hands it to a parent
session or to any runtime that did not opt in. A yield-enabled child registers the entry directly
on its own registry after construction (`runtime/methods/subagent.ts`), because the constructor
has already run `registerBuiltInTools` by then. Consequence: the parent tool surface is
byte-identical to today, verified by test.

**The allowlist question (measured, not assumed).** `config.toolAllowlist` reaches exactly two
consumers: `registerBuiltInTools` (as a registration filter) and MCP tool filtering. Neither
builds the model-facing tool list — that is derived from the registry. So a tool registered on the
child registry is visible to the model regardless of the allowlist. `YIELD_TOOL_NAME` is *also*
appended to `childToolAllowlist`, following the existing `RespondToCoordinator` control-channel
precedent: it is a no-op for registration today, and it prevents a future layer that derives
model-visible tools from the allowlist from silently hiding `Yield`. Verified by a child-runtime
simulation test (yield child sees and executes `Yield`; legacy child does not; two yield children
keep separate collectors).

## 4. Phase 1 — schema carrier (profile → runtime config)

**File:** `apps/zcode-cli/packages/core/src/subagent/profile.ts`

Today `AgentProfile` carries `memory?: AgentMemoryScope` (frontmatter `memory:`), parsed at
line ~187. Add a sibling:

```ts
/** `yield: true` enables the structured result contract for this agent. */
export type AgentYieldMode = "structured";

export interface AgentProfile {
  // …existing fields…
  memory?: AgentMemoryScope;
  /** NEW: present only when frontmatter declares `yield: true`. */
  yield?: { mode: AgentYieldMode; schema: unknown /* JSON Schema */ };
}
```

Parsing (next to the existing `memory` parse, so both share the same diagnostics shape):

```ts
const memory = parseAgentMemoryScope(frontmatter.memory);
const memoryDiagnostic = /* …existing… */;
const yieldContract = parseYieldContract(frontmatter);   // NEW

/**
 * `outputSchema` comes in as raw JSON from frontmatter (not a zod schema), so we do
 * not pass it through `toToolJsonSchema` — that helper is for zod runtime schemas.
 * We only syntactically check it here; data is validated at runtime with the
 * repo's existing `validateJsonSchemaValue` (
 * `core/src/tool/json-schema.ts`).
 */
function parseYieldContract(frontmatter: Record<string, unknown>): AgentProfile["yield"] | undefined {
  if (frontmatter.yield !== true) return undefined;      // absent ⇒ legacy behaviour
  const schema = frontmatter.outputSchema;
  if (!isRecord(schema) || Object.keys(schema).length === 0) {
    throw new AgentProfileError("agent_invalid_yield_schema", {
      path: frontmatter.__path,
      message: "Agent frontmatter `yield: true` requires a non-empty `outputSchema` object.",
    });
  }
  return { mode: "structured", schema };
}
```

Frontmatter that turns it on:

```markdown
---
name: routes-exporter
description: Enumerate route exports
yield: true
outputSchema:
  type: object
  required: [exports]
  properties:
    exports: { type: array, items: { type: object, properties: { path: {type: string} }, required: [path] } }
    notes: { type: string }
---
```

**Acceptance:** a profile without `yield:` produces a byte-identical `AgentProfile`;
`yield: true` without `outputSchema` is rejected with a diagnostic instead of loading.

## 5. Phase 2 — the `Yield` tool (child side)

**New file:** `apps/zcode-cli/packages/core/src/tool/handlers/yield.ts`

Registered **only** into a child runtime whose profile declared `yield` — the parent's own tool
surface must not grow a new tool, or every turn's prompt changes.

```ts
export const YIELD_TOOL_NAME = "Yield";

/** Mirrors `omp`'s bounded retry: three consecutive failures, then accept-and-warn. */
const MAX_SCHEMA_RETRIES = 3;

export function createYieldToolEntry(schema: unknown, onYield: (item: YieldItem) => void): ToolEntry {
  const { validate, jsonSchema, requiredFields } = buildOutputValidator(schema);
  let schemaFailures = 0;

  return {
    name: YIELD_TOOL_NAME,
    // `read` approval: yielding is not a side effect, it is the report itself.
    approval: "read",
    description: YIELD_DESCRIPTION,           // prompts/tools/yield.md
    inputSchema: /* { data?, error?, useLastTurn? } */,
    handler: async (input, context) => {
      const data = input.data;
      if (data === undefined && input.error === undefined) {
        throw new Error(YIELD_FORMAT_HINT);   // retryable: model re-calls
      }
      if (data !== undefined) {
        const result = validate?.(data);
        if (result && !result.success) {
          if (++schemaFailures <= MAX_SCHEMA_RETRIES) {
            const remaining = MAX_SCHEMA_RETRIES - schemaFailures;
            throw new Error(
              `Yield data does not match the output schema: ${formatIssues(result.issues)}. ` +
              `Call Yield again with the corrected shape — ${remaining} retry attempt(s) remain.`,
            );
          }
          // Budget exhausted: record the override and accept, so a schema we cannot
          // express never wedges the child forever.
          schemaFailures = 0;
          onYield({ data, schemaOverridden: true, missingRequired: requiredFields });
          return ok({ accepted: "schema_overridden" });
        }
        schemaFailures = 0;                   // consecutive budget resets on success
      }
      onYield({ data, error: input.error, useLastTurn: input.useLastTurn });
      return ok({ accepted: true });
    },
  };
}
```

Error text must mirror upstream's so the model learns the same lesson:
```
Yield data does not match the output schema: <issues>. Call Yield again with the corrected
shape — N retry attempt(s) remain before the schema constraint is dropped.
```

**New prompt:** `apps/zcode-cli/packages/core/src/prompts/tools/yield.md`

```
Submit your result. Exactly one of:
- success → {"data": <object matching the output schema>}
- failure → {"error": "<the concrete blocker>"}
Never fabricate a blocker. Do not send prose as the report.
```

**Acceptance:** a child that yields a schema-violating payload gets a retryable error naming the
failing fields; three consecutive failures are accepted with an override flag rather than
looping forever.

## 6. Phase 3 — finalize (executor side)

**File:** `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` (child factory,
around the `new AgentRuntime({…})` at line ~239) plus a new `finalize-subagent-yield.ts`.

The child already returns through `childRuntime.executeTurn(...)` (line ~398). We collect yields
on the instance created there and finalize after it resolves:

```ts
// finalize-subagent-yield.ts
export interface SubagentYieldItem {
  data?: unknown;
  error?: string;
  useLastTurn?: boolean;
  schemaOverridden?: boolean;
}

export interface FinalizedYield {
  /** Merged payload: array-declared properties accumulate, scalars replace. */
  data: unknown;
  warnings: string[];
  /** True when the schema was satisfied (or forcibly overridden). */
  ok: boolean;
}

export function finalizeSubagentYield(args: {
  yields: SubagentYieldItem[];
  schema: unknown;
  lastAssistantText: string;
}): FinalizedYield {
  const { yieldSectionShapes } = resolveShapes(args.schema);
  let data: Record<string, unknown> = {};
  const warnings: string[] = [];
  let sawAny = false;

  for (const item of args.yields) {
    if (item.data === undefined || item.data === null) continue;
    sawAny = true;
    const section = isRecord(item.data) ? item.data : { value: item.data };
    for (const [key, value] of Object.entries(section)) {
      if (yieldSectionShapes.get(key) === "array") {
        const existing = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
        data[key] = [...existing, value];          // accumulate
      } else {
        data[key] = value;                          // replace
      }
    }
    if (item.schemaOverridden) warnings.push(SUBAGENT_WARNING_SCHEMA_OVERRIDDEN);
  }

  if (!sawAny) {
    warnings.push(SUBAGENT_WARNING_NULL_YIELD);
    return { data: undefined, warnings, ok: false };
  }
  return { data, warnings, ok: true };
}
```

Merging rule is upstream's, verbatim in intent (`yield-assembly.ts`): a repeated yield on an
array-declared field **accumulates**; a repeated yield on a scalar field **replaces**, because
assembling an array the schema did not declare would fail validation.

Then the completed-output path gains the structured branch (same file,
`subagent.ts` → the runtime that builds `AgentCompletedOutput`):

```ts
// Before: content = child text blocks.
// After, when profile.yield is set:
const finalized = finalizeSubagentYield({ yields, schema: profile.yield.schema, lastAssistantText });
if (finalized.ok) {
  output = {
    status: "completed",
    agentId, agentType, description, prompt,
    structured: { data: finalized.data, warnings: finalized.warnings },
    // content stays, but the formatter below uses `structured` instead of the text blocks
    content: [{ type: "text", text: lastAssistantText }],
    totalToolUseCount, totalDurationMs, totalTokens, usage,
  };
}
```

**Contract:** `apps/zcode-cli/packages/contracts/src/tools/agent.ts` gains an optional field so
`AgentCompletedOutputSchema` stays backward compatible (`.strict()` + `.optional()`):

```ts
export const AgentStructuredOutputSchema = z.object({
  data: z.unknown(),
  warnings: z.array(z.string()),
}).strict();

export const AgentCompletedOutputSchema = z.object({
  // …existing…
  structured: AgentStructuredOutputSchema.optional(),
}).strict();
```

**Acceptance:** two incremental yields of `{exports: [...]}` merge into one array; a repeated
scalar `{notes: "a"}` then `{notes: "b"}` ends as `"b"`; a child that never yields produces
`ok: false` and the null-yield warning, not a fake success.

## 7. Phase 4 — the parent-facing envelope

**File:** `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts` (`formatAgentOutputForModel`)

```ts
/** Inline preview budget before the envelope points at the agent id instead. */
const AGENT_RESULT_PREVIEW_LIMIT = 5_000;

function previewHead(text: string): string {
  const slice = text.slice(0, AGENT_RESULT_PREVIEW_LIMIT);
  const lastNewline = slice.lastIndexOf("\n");
  // Prefer a line boundary so a markdown preview never ends mid-row; hard-cut only
  // when the boundary is near the start (pretty-printed JSON would preview as `{`).
  return lastNewline >= AGENT_RESULT_PREVIEW_LIMIT / 2 ? slice.slice(0, lastNewline) : slice;
}

function formatStructuredResult(data: AgentStructuredOutput, output: AgentOutput): string {
  const body = typeof data.data === "string" ? data.data : JSON.stringify(data.data, null, 2);
  const preview = body.length > AGENT_RESULT_PREVIEW_LIMIT ? previewHead(body) : body;
  const lines = [
    `agent_result: ${data.warnings.length > 0 ? data.warnings.join("; ") : "ok"}`,
    `<result${body.length > AGENT_RESULT_PREVIEW_LIMIT ? ` full-output="${output.agentId}"` : ""}>`,
    preview,
    "</result>",
    `agentId: ${output.agentId} (use SendMessage with to: '${output.agentId}' to resume this agent)`,
    `<usage>tool_uses: ${output.totalToolUseCount}; duration_ms: ${output.totalDurationMs}</usage>`,
  ];
  return lines.join("\n");
}
```

`formatAgentOutputForModel` then picks a branch — **legacy path untouched**:

```ts
if (data.status !== "async_launched") {
  if (data.structured) return formatStructuredResult(data.structured, data);
  /* …existing childText branch, byte-for-byte… */
}
```

**Acceptance:** a structured child with a 60 KB payload renders ≤ ~5 KB in the parent's context;
an agent without `yield` renders exactly as it does today; the `agentId` line names the resume
semantics (closes G5).

## 8. Phase 5 — the nudge (make the contract discoverable)

**As built:** the reminder is `YIELD_AGENT_PROMPT` in `tool/handlers/yield.ts` (co-located with
the tool it describes, so the two cannot drift), joined as the **last** segment of the child's
agent prompt, and only when `profile.yield` is set (`runtime/methods/subagent.ts`). A profile
without the contract gets a byte-identical prompt.

```
## Structured result

Your result for this task must be reported with the Yield tool.

- Call Yield once at the end with `data` matching your required output schema.
- Call it again to append to array-typed sections while you keep working.
- A rejected payload comes back with the schema errors; fix it and call Yield again.
- Do not write the structured result as prose: prose is not read by your caller.
```

The reminder deliberately does **not** restate the schema. The tool already echoes the exact
failing paths back on every rejection, and a duplicated schema in prose would be a second source
of truth that can disagree with the enforced one.

Note on divergence from the original sketch in this document: the drafted version told the child
to Yield `{"error": …}` on failure. That was dropped — a failure expressed as a payload field
would have to live *inside* the author's schema, which the profile does not control. Failure is
carried by the contract itself (`ok:false` + issues), not by the child.

## 9. Migration boundary — what old behaviour is removed

Explicitly in scope for "remove old behaviour":

| Old behaviour | Where | Action |
|---|---|---|
| `(Subagent completed but returned no output.)` as a success string | `agent.ts:140` | Removed for yield-enabled agents; kept for legacy ones (it is their only signal). |
| Unbounded `data.content` into the parent | `agent.ts:138` | Bounded to 5 KB for yield-enabled agents. |
| No retry on a malformed report | — | Replaced by the 3-retry ladder (yield-enabled only). |

Explicitly **not** removed (different surface, still needed):
`SendMessage` resume, `output_file` for async runs, subagent persistent memory, the
`(Subagent completed but returned no output.)` string on the legacy path.

## 10. Acceptance gates

1. `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm architecture:check --changed` (0 new).
2. `node apps/zcode-cli/packages/cli/scripts/build.mjs` emits `dist/zcode.cjs`.
3. New unit tests, all in-repo:
   - `yield` rejects a schema-violating payload with a message naming the failing field and the
     remaining retry count; three consecutive failures accept with the override flag;
     a success resets the consecutive counter.
   - `finalizeSubagentYield` merges two array-section yields into one array; a repeated scalar
     yields the later value; a child that never yields returns `ok: false` + the null-yield warning.
   - `formatStructuredResult` renders ≤ 5 KB for a 60 KB payload and includes the
     `full-output="<agentId>"` marker; a legacy output renders byte-identically to before.
   - A profile with `yield: true` and no `outputSchema` is rejected with
     `agent_invalid_yield_schema`.
4. Grep proofs: `Yield` is absent from a parent runtime's tool list; present in a yield-enabled
   child's. `formatAgentOutputForModel`'s legacy branch is unchanged.
5. No JS/TS fallback is introduced: the contract is validated in the same pass that produces it —
   there is no "if structured parsing fails, use the raw text" branch. A yield-enabled child whose
   payload cannot be validated is reported as a **failure**, not silently downgraded.

## 11. Risks

| Risk | Mitigation |
|---|---|
| A model's schema is not expressible (e.g. unions) | The 3-retry override accepts it and records `SUBAGENT_WARNING_SCHEMA_OVERRIDDEN`, so a child can never wedge. |
| Prompt churn for every existing agent | Contract is opt-in per profile; no `yield:` ⇒ byte-identical. |
| Double counting: a child both yields and writes prose | Prose becomes the `useLastTurn` fallback only when explicitly requested; otherwise prose is not part of the result. |
| Model ignores the contract entirely | The nudge ladder + the executor's `ok: false` path surface a loud null-yield warning to the parent rather than a fake completion. |
## 12. As-built record (implementation complete)

### Files changed

| File | Change |
|---|---|
| `apps/zcode-cli/packages/core/src/subagent/profile.ts` | `AgentProfile.yield = { mode: "structured"; schema: JsonSchema }`; parsed from frontmatter; `yield: true` without a usable `outputSchema` emits diagnostic `agent_invalid_yield_schema` and leaves `profile.yield` unset (never a silent opt-out). |
| `apps/zcode-cli/packages/core/src/tool/handlers/yield.ts` (new) | `YIELD_TOOL_NAME = "Yield"`, `MAX_SCHEMA_RETRIES = 3`, `createYieldTool({ schema, collector })` (per-subagent retry state), `YIELD_AGENT_PROMPT`. |
| `apps/zcode-cli/packages/core/src/subagent/finalize-yield.ts` (new) | `finalizeSubagentYield({ items, schema })`; merge rule; `SUBAGENT_WARNING_NULL_YIELD`, `SUBAGENT_WARNING_SCHEMA_OVERRIDDEN`. |
| `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` | Registers `Yield` on the **child** registry only when `yieldContract` is set; collects yields; appends the prompt segment; finalizes after `executeTurn` and returns `structured`. |
| `apps/zcode-cli/packages/core/src/subagent/runner.ts` | Carries `structured` from the child result onto `AgentCompletedOutput` (omitted when absent). |
| `apps/zcode-cli/packages/contracts/src/tools/agent.ts` | `AgentStructuredResultSchema` + optional `structured` on `AgentCompletedOutput` (zod **and** the hand-written interface). |
| `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts` | `AGENT_RESULT_PREVIEW_LIMIT = 5_000`, `previewHead`, `formatStructuredResult`; `structured` added to the hand-written provider output schema (`additionalProperties:false`, so it had to be declared or valid results would be rejected). |

### Invariants held

- **Owner:** one owner per fact. The child tool owns the retry counter and the raw yields; the
  child runtime owns finalization; the parent-facing formatter only renders. No state is shared
  across subagents — each gets its own tool instance (tested).
- **Legacy parity:** no `yield:` in frontmatter ⇒ no tool, no prompt segment, no `structured`
  field ⇒ byte-identical tool list, prompt, and model-visible output (tested).
- **No silent downgrade:** a contract violation is `ok:false` with issues. There is no branch
  that falls back to the child's prose (tested, including that the prose is not re-rendered as
  the result).
- **Size bound is parent-side only:** the child's own context is never truncated.
- **Loud failure:** under-budget violations produce `SUBAGENT_NULL_YIELD`; budget-exhausted ones
  produce `SUBAGENT_YIELD_SCHEMA_OVERRIDDEN` **plus** the schema issues. Warnings survive both the
  `ok:true` and `ok:false` branches — an earlier draft dropped them on failure, which made a spent
  retry budget invisible to the parent; the test for that case is the regression guard.

### Verification run

| Gate | Result |
|---|---|
| `pnpm typecheck` per CLI package (adapters, bootstrap, cli, contracts, core, shared-types) | 6/6 OK |
| `pnpm typecheck` (root, `tsc -b` over 11 packages) | OK |
| `pnpm lint` | 52 warnings, **0 errors** (unchanged from baseline) |
| `pnpm architecture:check --changed` | OK — violations 0, baseline 0, new 0 |
| CLI build (`packages/cli/scripts/build.mjs`) | OK — `dist/zcode.cjs` emitted; contract strings present in the bundle |
| Contract strings in the built bundle | `agent.yield.report`, `SUBAGENT_NULL_YIELD`, `SUBAGENT_YIELD_SCHEMA_OVERRIDDEN`, `structured-result`, `agent_invalid_yield_schema` all present |
| `cargo test` (tauri) | 263 passed / 12 failed — identical to the pre-existing baseline; no Rust touched |
| Scenario suites (profile, finalize, tool, envelope, isolation, e2e) | 6/6 pass |

`pnpm knip` and `pnpm fmt:check` fail at baseline and are not gates (`pnpm verify:pre-push` =
lint + architecture). The new exports knip lists are the contract constants
(`YIELD_TOOL_NAME`, `MAX_SCHEMA_RETRIES`, the warning strings, the public input/result types);
`packages/core` has no colocated test runner in this checkout, so nothing imports them yet.

### Known pre-existing issue found while building

`apps/zcode-cli/packages/bootstrap/dist/app/paths.js` was a stale build artifact predating the
Workspace Memory removal and still imported `resolveProjectMemoryRoot`, which no longer exists.
The CLI build only failed once `core/dist` was rebuilt. Fixed by rebuilding the CLI packages in
dependency order (`shared-types → contracts → core → adapters → bootstrap`). Worth knowing: a
stale `dist` in this workspace can mask or invent build errors, so rebuild from source before
trusting a CLI build failure.

## 13. Adversarial review round (subagent-driven) and the fixes it forced

A `general-purpose` subagent was pointed at this contract as a reviewer. It returned 14
findings: 3 blocking, 11 likely/spec-gap. Every one was verified against the source before
acting; the blocking ones were all real. Status below is the state after this round.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Blocking** | `Yield` was hard-denied in plan mode (`readOnly: false`, no `allowedInPlanMode`) → every call got `deny("mode.plan.nonReadOnly")`, so a yield-enabled child spawned under plan mode could **never** satisfy its contract and always reported `SUBAGENT_NULL_YIELD`. | **Fixed** — `allowedInPlanMode: true`, matching the `respond-to-coordinator.ts` precedent. Reporting a result is not a side effect. |
| 2 | **Blocking** | The structured block was **appended after** the child's prose instead of replacing it, so the 5 KB bound was cosmetic: a verbose child still shipped up to 120 KB of prose first, and the executor's own truncation could cut the `full-output` marker and warnings off entirely. | **Fixed** — `if (data.structured) return [...formatStructuredResult(...), ...trailer]`. The contract result replaces the prose. |
| 3 | **Blocking** | `ok:false` still shipped the rejected prose, so "no prose fallback" held only for the `structured` field, not for what the model actually reads. | **Fixed** — same branch as (2). |
| 4 | Likely | Background/async runs build their completion notification from `output.content` only: no `structured`, no warnings, no bound. | **Open** — needs a protocol/telemetry field (see below). |
| 5 | Likely | The retry counter was never reset after an override, so once spent, **every** later yield in that run was force-accepted with no feedback to the model. | **Fixed** — the budget resets on override. |
| 6 | Likely | The retry message text did not match the spec's mandated wording. | **Open** — cosmetic; deferred with (4). |
| 7 | Likely | `registry.register` bypasses the allowlist **and** the disallow rules, so `disallowedTools: [Yield]` (or a parent-level ban) could not suppress the tool. | **Fixed** — the rules are evaluated explicitly through `buildSubagentChildDisallowRules` + `filterSubagentChildToolNames`; a declared-but-disallowed contract reports `ok:false` + `SUBAGENT_YIELD_TOOL_DISALLOWED`. |
| 8 | Likely | Post-construction registration never invalidated the memoized `cachedTools`, so `Yield`'s visibility depended on call ordering luck. | **Fixed** — `invalidateToolCache` is called after registering. |
| 9 | Likely | Resume (via `SendMessage`) rebuilds the child runtime, so yields from earlier turns are lost and the merge can fail `required` even though the child reported it. | **Open** — needs yield persistence in the child session store; not a quick fix. |
| 10 | Likely | Two independent copies of the merge rule, already diverging on non-object payloads. | **Fixed** — one exported `mergeYieldData`, imported by both. |
| 11 | Likely | `diagnostic` is a single slot, so a bad `memory:` plus a bad `outputSchema` lost one diagnostic. | **Fixed** — added a `diagnostics` array; `diagnostic` kept as the back-compat first entry. |
| 12 | Likely | `yield: true` with a broken schema only logged a warning and **still loaded the profile** — a silent opt-out, i.e. exactly what §12 forbids. | **Fixed** — the profile is rejected, like the `mcpServers` branch. |
| 13 | Likely | `resultBudget` bounds what the child sees, not `childYieldItems`; a runaway child could grow memory and the parent-facing JSON without bound. | **Fixed** — `MAX_CHILD_YIELD_ITEMS` caps the accumulator. |
| 14 | Minor | `YieldToolInput.note` is advertised but never read; input is cast rather than validated. | **Open** — minor. |

### A design bug the fixes exposed

Cumulative validation plus accept-with-override interact badly: an overridden payload that is
merged into the validation accumulator **poisons the whole run**. With
`additionalProperties: false`, one bad key makes every later, *correct* yield fail too — the
correction channel dies permanently. The override path therefore does **not** merge into the
accumulator; the finalizer still re-validates everything that was recorded, so nothing is
laundered. Regression-tested.

### Known-open items (honest list)

1. **Background/async runs carry no contract result** (4, 6): the foreground path is complete;
   the async completion notification still needs a `structured` field, which means a protocol
   change in `packages/shared/src/zcode-protocol*` per the protocol-sync rule.
2. **Resume loses earlier yields** (9).
3. **In-repo tests**: this checkout has no test runner in `packages/core`, so the suites run as
   tsx scripts. They are not committed to the repo, which is a real gap against §10.3 — adding a
   runner is its own change.

## 14. Second adversarial review round (cross-feature audit)

A second subagent was pointed at the **whole** change set (not just this contract). It surfaced a
regression that belonged to the Workspace-Memory removal, not to the yield work — and it exposed a
**blind spot in how the Rust suite was being verified**.

### The regression: a stale generated fixture broke 2 Rust tests

`memoryEnabled` was removed from the zod settings schema and from `default_settings()` in
`setting.rs`, but the pinned fixture generated from that schema
(`apps/zcode-tauri/src-tauri/tests/settings-defaults.json`) was never regenerated. Two tests in
`--test setting_channel` failed on a one-line diff (`"memoryEnabled": false`).

**Why it was missed:** `cargo test` stops at the first failing test binary. Every previous run
reported only the `--lib` result (263/12) and never reached the integration binaries. The correct
verification is `cargo test --no-fail-fast`, which runs all of them:

| Binary | Result |
|---|---|
| `--lib` | 263 passed / 12 failed (pre-existing baseline) |
| integration binaries | 40 + 12 + 19 + 4 passed, 0 failed |

Fix: `pnpm exec tsx scripts/gen-settings-defaults.ts > apps/zcode-tauri/src-tauri/tests/settings-defaults.json`.

One of the 12 `--lib` failures is environment-specific, not a code defect:
`commands::fs::tests::refuses_an_absolute_path_outside_the_allowed_root` canonicalizes
`/root/.ssh/id_rsa`, which fails with `Permission denied` for a non-root user *before* the
containment check can run. It cannot pass on this machine.

### Other findings from this round

| # | Finding | Resolution |
|---|---|---|
| 3 | The truncation escape hatch pointed at content that was never written: `structured` was not persisted to any artifact, and `SendMessage` resumes an agent rather than retrieving stored sections. | **Fixed** — the full structured result is written to `<outputFile>.structured.json` (and mirrored into `metadata.json`), and the truncation hint now names that file instead of `SendMessage`. |
| 6 | `AgentRuntimeOptions.memoryRoot`, `ContextBuilderConfig.memoryRoot` and `memoryIndexContent` had zero producers after the memory removal — dead fields on protocol-adjacent types, invisible to knip. | **Fixed** — removed. |
| 7 | `workspace-memory-removal.md` contradicted itself on `--memory-bench` (flag "kept" vs deleted) and on `MemoryRuntimeConfig` (removed vs kept). | **Fixed** — spec corrected: the flag is fully removed (loudly, via strict `parseArgs`) and `MemoryRuntimeConfig` is deliberately kept for subagent memory. |
| 8 | A comment about the memory section was inserted *between* the Computer Use comment and its own id, leaving two comments over two ids with nothing binding either to its item. | **Fixed** — each comment sits directly above the id it describes. |
| 9 | `rpc.rs`'s onboarding-record test depends on real process state (a real credential key and the developer's real `~/.zcode`), so it would panic in a CI sandbox; `setting_channel.rs` solves the same problem with `with_isolated_home`. | **Open** — pre-existing test-hygiene gap, not from this work. |
| 10 | `rust-native-server.md` claimed 41 service channels; there are 40 after the memory removal. | **Fixed** — corrected, with the reason. |
| 2 | `rust-native-server.md` claimed `cancel` drops the prompt-attachment senders; the Node original (`promptAttachmentTransferService.ts:39-41`) has `async cancel() {}`, so the Rust port's no-op is correct and the spec was wrong. | **Fixed** — spec corrected; the port was right. |

### Verification after this round

`--no-fail-fast` cargo (all binaries), 7/7 tsx suites, 6/6 CLI package typechecks, root
typecheck clean, lint 52 warnings / 0 errors, architecture 0 violations, CLI build OK.
