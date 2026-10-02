# Rust native port: automation schedule computation (`zcode-cron`)

Status: active. Owner: CronSpecAuthor. Written 2026-09-30 **before** any implementation code,
per the umbrella spec's Tauri/shell-replacement scope (`docs/specs/rust-native-ports.md:66`
"Deferred: Electron/Shell-level replacement (Tauri)"), `AGENTS.md:3`, and the
architecture-governance rule ("Write or update the spec before implementation … state the
behavior, ownership, invariants, failure semantics, and migration boundary").

This wave delivers **only this file**. No crate, wrapper, or consumer change exists yet.

---

## 0. Naming reconciliation: why this port, and why not for speed

The umbrella spec's invariant 10 says *"only port the primitives that win"* — native wins on
full-payload compute, never on sub-microsecond primitives. **This port is explicitly not that
kind of port, and the distinction matters, so it is stated first.**

| Motivation | Applies here? |
|---|---|
| Speed (a JS hot path is measurably slow) | **No.** Cron computation runs at most once per automation per 20 s scheduler tick. It is not hot. Porting it for speed would be unjustified, and the spec would be wrong to claim otherwise. |
| **Capability (a Rust host cannot run the feature at all)** | **Yes.** This is the entire justification. |

The capability gap is documented in-tree, in three places:

- `apps/zcode-tauri/src-tauri/src/lib.rs:167` — `next_run_at_ms` is `None` "because
  `computeAutomationNextRunAt` has no Rust port".
- `apps/zcode-tauri/src-tauri/src/scheduler_store.rs:557` — "`computeAutomationNextRunAt`
  (`scheduler/index.ts:146`), which has no Rust port yet".
- `apps/zcode-tauri/PORT_STATUS.md:135-141` — "the schedule never advances until the cron
  computation is ported".

The concrete defect: in the Tauri host a **recurring** automation that misses its fire is
re-claimed as a misfire on every 20 s tick and never rescheduled. `skip_misfire(…, None)`
COALESCEs, so the claim is released (no leak) and the run row is upserted in place on the same
`run_id` (no row growth) — but `next_run_at` is never written, so the schedule stalls. This is
safe-but-broken, and it is the last blocker standing between the Tauri scheduler and parity
with `packages/desktop/src/scheduler/index.ts:146`.

**Ported component = the whole `packages/services/src/session/automationCron.ts` (360 lines)
plus `automationCronValidation.ts`.** Both are pure computation over numbers and calendar
fields: no I/O, no clock read except the explicit `from` parameter, no process, no env.

---

## 1. Motivation (structural facts, verified 2026-09-30)

1. **The port is pure.** All eight exported functions take primitives and return primitives.
   `Date.now()` appears only as a default parameter value; every computation is a pure
   function of `(rule, from)`. That makes it testable, which the current TS is not.
2. **The current implementation is untested.** The repo has no test runner (§1.4 of
   `docs/specs/rust-native-packaging.md` records 5 test files repo-wide, no runner). A 360-line
   calendar computation that decides *when a user's automation fires* has zero automated
   coverage. Porting it into a crate with `cargo test` is the cheapest available way to get
   that coverage.
3. **The consumer is already half-migrated.** `apps/zcode-tauri/src-tauri/src/scheduler_store.rs`
   has the automation schema transcribed verbatim from `AUTOMATION_SCHEMA`
   (`packages/rust/crates/zcode-task-index/src/schema.rs`), and
   `supervisor/scheduler.rs` implements the 20 s poll, single-flight tick, 5 min misfire grace,
   one-shot finalisation and the stable `${automationId}:${scheduledAt}` run id — all
   unit-tested. The schedule computation is the single remaining TypeScript dependency in that
   chain.
4. **No test runner exists for the TS.** `AGENTS.md:27` explicitly says "do not assume a unified
   unit test or E2E command exists", and none does for this module.

## 2. Scope

### 2.1 Ported

- `scheduleRuleDefinition` (`:16-23`)
- `isOneShotAutomation` (`:45-48`)
- `computeNextRunAt` (`:61-64`) — the raw cron-expression path, currently `croner`
- `buildRelativeDelaySchedule` (`:72-83`)
- `computeInitialAutomationNextRunAt` (`:95-119`) — including the stale-one-shot throw
- `computeScheduleRuleNextRunAt` (`:138-226`) — the six-unit engine
- `inferMinuteIntervalScheduleRule` (`:228-240`)
- `buildIntervalScheduleRule` (`:301-348`) — the interval carrier normaliser
- `computeAutomationNextRunAt` (`:353-358`) — the entry point both schedulers call
- `automationCronValidation.ts` → `isValidCronExpr` — **host-only**; §2.5/8 records why this
  ported export must never be reachable from the `@zcode/services` root barrel.

### 2.2 NOT ported (siblings / non-goals)

- **The scheduler loop itself** (`packages/desktop/src/scheduler/index.ts` claim/dispatch/
  finalise) stays TypeScript. It is I/O and ordering, not computation, and the Tauri host
  already has its own supervisor for it.
- **`automationRepo.ts` writeback** (`:1144-1151` one-shot finalisation, `:953` deleted-row
  discard) — SQL, not computation.
- **Model-visible schedule rendering** — presentation, stays TypeScript.
- **The `automation` row schema** — already transcribed in `scheduler_store.rs`; not re-done.
- **`croner` itself is not ported; it is replaced.** The Rust `cron` crate is a different
  implementation (§5.2), so the parity burden is real and is the centre of this spec.

### 2.3 Sync vs async decision (event-loop rule 4)

**Every** export is synchronous and pure. The largest is `computeScheduleRuleNextRunAt`'s
monthly branch, which loops at most `1200 / interval + 1` times over cheap integer arithmetic —
microseconds. Making it an `AsyncTask` would add a promise hop to a value the scheduler needs
inline. This is the same reasoning `zcode-events` §2.3 uses to keep `close()` sync, applied in
the other direction: **the rule is "MUST run off the loop when I/O can exceed ~1 ms"; this
port has no I/O at all, so the rule does not trigger.**

### 2.4 Ownership

| Piece | Owner |
|---|---|
| `packages/rust/crates/zcode-cron/**`, `packages/rust/src/cron.ts`, this spec | CronSpecAuthor |
| `packages/rust/Cargo.toml` (workspace dep), `packages/rust/package.json` (subpath export), `apps/zcode-tauri/src-tauri/Cargo.toml` | main session — requests in §10 |
| `packages/services/src/session/automationCron.ts` + `automationCronValidation.ts` (deletion), `packages/services/src/scheduler/index.ts:13,146`, `packages/desktop/src/scheduler/index.ts:13,146` | CronSpecAuthor |
| `packages/shared/src/automation-types.ts` (the `ZCodeAutomationScheduleRule` interface) | **untouched** — it is the wire contract and already carried verbatim into `scheduler_store.rs` |
| The Tauri `None` workaround (`lib.rs:167`, `scheduler_store.rs:557`) | CronSpecAuthor |

### 2.5 Invariants

1. **Zero JS fallback.** `computeAutomationNextRunAt` resolves to exactly one implementation per
   process. The `croner` import is deleted, not feature-flagged. There is no
   `try { native } catch { croner }` shape anywhere (§8).
2. **Legacy deleted.** `automationCron.ts`'s engine is removed in the same change; it does not
   become a parallel reference implementation.
3. **Calendar parity is byte-exact, including DST.** Every `new Date(y, m, d, h, min, 0, 0)`,
   `setDate`, `setMinutes` and local getter in the legacy code has a named Rust equivalent with
   a fixture (§6). A mismatch is a bug to fix, never an enumerated divergence. This is the
   single risk that decides whether the port is safe (§11, R1).
4. **Timezone is the host's, not a parameter.** Legacy uses the process-local zone implicitly
   via `Date` local getters. The port must not add a timezone argument, because that would let
   two callers in one process disagree.
5. **No clock read.** The `from = Date.now()` default stays in the TypeScript wrapper, so the
   native function is a pure function of its arguments and a test can pin `from`.
6. **No process, no I/O.** The ported feature spawns nothing and touches no file.
7. **`croner` and its types are removed from `packages/services/package.json`.**
8. **`isValidCronExpr` is host-only — the renderer must never reach it** (rust-native-ports.md
   invariant 9). The engine is native, and the sandboxed renderer cannot load a `.node`: Vite
   externalizes `node:fs` and `packages/rust/src/loader.ts` throws `Module "node:fs" has been
   externalized for browser compatibility … Cannot access "node:fs.existsSync"`.

   The port shipped that reachability: `packages/ui/src/settings/useAutomationTemplates.ts`
   value-imported `isValidCronExpr` from the `@zcode/services` root barrel, and
   `index.ts:247` re-exported it from `automationCronValidation.ts` → `@zcode/rust/cron` →
   `loader.ts`. One line owned every chain — a reverse-graph trace of the Tauri renderer build
   found **386 chains**, and every one passed through
   `services/index.ts → session/automationCronValidation.ts → rust/cron.ts → loader.ts`.

   The fix is invariant 9's prescribed shape, not a branch: the root barrel
   (`@zcode/services`) stays renderer-safe, and the validator keeps its home on the Node-only
   subpath (`@zcode/services/node` → `automationCron.ts`), which is where host consumers read it
   from. There is still exactly one implementation.

   **What the renderer gates on instead:** `canVisualizeCronInAutomationEditor`, the round-trip
   through the builder — presentation, which §2.2 already keeps in TypeScript. Semantic
   authority stays with the host and is enforced on write: `automationService.ts:227` (create)
   and `:332` (update) reject an invalid expression with `InvalidCronExprError`, from this same
   engine. A differential run of the committed 65-expression corpus against the native binary
   measured the trade: **5 expressions** are structurally editable but semantically invalid
   (`60 * * * *`, `0 24 * * *`, `0 0 32 * *`, `61 * * * *`, `0 61 * * *`). They used to be
   filtered out of the template picker; now they are offered and refused on save with a typed
   error. That is the deliberate cost of a single engine and zero JS fallback — not a silent
   behavioural fork.

   Gate: `packages/shared/scripts/check-native-graph.mjs` now walks **value** imports (not
   `import type`, which the TS transform erases) from the renderer entries
   (`apps/zcode-tauri/src/main.tsx`, `packages/web/src/main.tsx`) across every workspace package
   — 1762 modules — and treats reaching `packages/rust/src/**` as the violation, reporting the
   full import chain. The roots-only scan that predates this could not see the bug at all: it
   checks *direct* `@zcode/rust` imports under a fixed list of directories, and neither
   `services/index.ts` nor `apps/zcode-tauri/src` was in that list. Re-adding the export now
   fails statically instead of re-breaking the build.

---

## 3. The `Date` problem, stated plainly

This is the whole difficulty. The legacy code is not doing arithmetic on timestamps; it is
doing **local-time calendar arithmetic through `Date`**, and `Date` has behaviour that
surprises people. Each of the following appears in `automationCron.ts` and each needs a pinned
Rust equivalent:

| Legacy expression | Line | JS behaviour that must be reproduced |
|---|---|---|
| `new Date(y, m, d, hour, minute, 0, 0)` | `:129` (`atTime`) | Local-time construction. **Normalises out-of-range fields**: month 13 → next year, day 32 → next month, hour 25 → next day. |
| `new Date(year, month + offset, 1)` | `:189` | Same normalisation, with `offset` up to 1200. |
| `new Date(y, m, day)` where `day` may be 0 or negative | `:195`, `:213` | Day 0 = last day of the previous month; negative days roll further back. Used by `firstWeekdayOfMonth` and the yearly branch. |
| `new Date(anchor.getFullYear() + offset, targetMonth, targetDay)` | `:213` | February 29/30 in a non-leap year **rolls into March**, then the code's `if (date.getMonth() !== targetMonth) continue;` skips it. The port must roll the same way, or the guard stops matching. |
| `anchorWeek.setDate(anchorWeek.getDate() - ((anchorWeek.getDay() + 6) % 7))` | `:170` | Monday-based week start via `setDate`, which can cross a month boundary. |
| `base.setMinutes(rule.minute, 0, 0)` | `:150` | Sets minutes **and** seconds/ms in one call; `setMinutes(70)` rolls the hour. |
| `getDay()` | `:171`, `:196` | Local weekday, 0 = Sunday. The code converts to Monday-based with `(d + 6) % 7`. |
| DST spring-forward gap | `:129` | `new Date(2024, 2, 10, 2, 30)` in `America/New_York` does not exist; JS yields 03:30 local. |
| DST fall-back overlap | `:129` | 01:30 occurs twice; JS picks the **earlier** (pre-transition) offset. |

`chrono`'s `Local` reproduces the construction and normalisation rules, and `chrono-tz` can pin
an explicit zone for testing — but "reproduces" is a claim that must be **proven by fixture**,
not asserted. §6 is that proof.

---

## 4. Naming reconciliation for the two `cron` meanings

"Cron" is overloaded in this repo and the collision is real:

| Thing | What it is | Where |
|---|---|---|
| A 5-field cron **expression** string | the compatibility display form, plus the raw path for automations with no `scheduleRule` | `automation.cronExpr`; computed by `croner` today |
| A `scheduleRule` | the authoritative structured recurrence (unit + interval + anchor + calendar fields) | `ZCodeAutomationScheduleRule` (`packages/shared/src/automation-types.ts:35-44`) |
| The **scheduler's** cron-like loop | 20 s poll, misfire grace, one-shot finalisation | `packages/desktop/src/scheduler/index.ts` — **not ported** (§2.2) |

The port covers the first two. It does **not** touch the third. The crate is named
`zcode-cron` after the *expression language*, and its two entry points are named
`computeNextRunAt` (expression) and `computeScheduleRuleNextRunAt` (rule) so the two never get
confused at a call site.

---

## 5. Design

### 5.1 Crate shape

```toml
# packages/rust/crates/zcode-cron/Cargo.toml
[package]
name = "zcode-cron"
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[lib]
crate-type = ["cdylib"]        # napi binary, like every other @zcode/rust crate

[dependencies]
napi = { workspace = true }
napi-derive = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
chrono = { workspace = true }        # local-time calendar arithmetic
```

Picked up by the existing `members = ["crates/*"]`. `zcode-packaging` will classify it as a
cdylib and, once a Node-only consumer exists, it becomes **live** and enters the payload
automatically — no change to the packaging tool is needed (§10).

### 5.2 Expression path: `croner` → `cron`

`computeNextRunAt` currently constructs `new Cron(cronExpr)` and calls `.nextRun(from)`. The
Rust `cron` crate's `Schedule::after(&DateTime<Local>)` is the equivalent. **These are
different implementations and their edge cases differ**, so:

- Only the documented subset is claimed: standard 5-field expressions, `*`, numbers, `*/step`,
  ranges, and comma lists.
- Anything outside it returns `null` (no future fire), which is the same value legacy returns
  when `croner` cannot schedule — **but for different inputs**, so §6 requires a differential
  corpus rather than a hand-picked list.
- `croner`'s `previousRuns(1, date)` (used by `computeInitialAutomationNextRunAt` at `:104`)
  becomes `Schedule::after_prev(&DateTime<Local>)`, and the one-shot staleness maths around it
  is ported verbatim.

### 5.3 The structured path

`computeScheduleRuleNextRunAt` is ported branch-for-branch, keeping the legacy search bounds
because they are load-bearing and documented as such:

| Unit | Legacy bound | Kept? | Why |
|---|---|---|---|
| minute | closed form, no loop | yes | already closed-form in legacy |
| hourly | closed form | yes | already closed-form |
| daily | `index < 36_600` | yes | 100 years of days; the bound is the algorithm |
| weekly | `week < 5_220` | yes | ~100 years of weeks |
| monthly | `offset <= 1_200` | yes | the comment at `:187-188` explains the inclusive bound is deliberate |
| yearly | `offset < 400` | yes | 400-year cycle covers the Feb-29 case |

Changing a bound changes when a schedule reports "no future fire" and is therefore a behaviour
change, not an optimisation. None are changed.

### 5.4 napi surface

Deliberately flat and JSON-shaped, matching the house pattern
(`crates/zcode-events/src/lib.rs`, invariant 8: bytes cross as `Buffer`).

```rust
#[napi(object)]
pub struct ScheduleRule {
  pub unit: String,            // "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly"
  pub interval: f64,
  pub hour: f64,
  pub minute: f64,
  pub anchor_at: f64,          // epoch ms
  pub weekdays: Option<Vec<f64>>,
  pub month_days: Option<Vec<f64>>,
  pub months: Option<Vec<f64>>,
  pub monthly_mode: Option<String>,
}

#[napi]
pub fn compute_next_run_at(cron_expr: String, from: f64) -> Option<f64>;

#[napi]
pub fn compute_schedule_rule_next_run_at(rule: ScheduleRule, from: f64) -> Option<f64>;

#[napi]
pub fn compute_automation_next_run_at(
  cron_expr: String,
  rule: Option<ScheduleRule>,
  from: f64,
) -> Option<f64>;

#[napi]
pub fn build_interval_schedule_rule(
  interval_unit: String, interval: f64, cron_expr: String, anchor_at: f64,
) -> Result<ScheduleRule>;

#[napi]
pub fn infer_minute_interval_schedule_rule(cron_expr: String, anchor_at: f64) -> Option<ScheduleRule>;

#[napi]
pub fn build_relative_delay_schedule(delay_minutes: f64, from: f64) -> RelativeDelaySchedule;

#[napi]
pub fn is_one_shot_automation(recurring: bool, max_runs: Option<f64>) -> bool;

#[napi]
pub fn schedule_rule_definition(rule_json: String) -> Result<String>;

/// The one-shot staleness error crosses as a typed napi error so the TypeScript wrapper can
/// re-raise the legacy `StaleOneShotAutomationScheduleError` with its original message.
#[napi]
pub fn compute_initial_automation_next_run_at(
  cron_expr: String, recurring: bool, rule: Option<ScheduleRule>, from: f64,
) -> Result<Option<f64>>;

#[napi]
pub fn is_valid_cron_expr(expr: String) -> bool;
```

Two details that are easy to get wrong:

- **`is_one_shot_automation` takes `maxRuns` as `Option`.** Legacy reads
  `(automation.maxRuns ?? 1) <= 1`; a `Some(0)` must be one-shot, and a missing field must
  behave as `1`, not as `0`.
- **`schedule_rule_definition` must reproduce `JSON.stringify` byte-for-byte**
  (`automationCron.ts:19-22`), including that the weekday/month-day/month arrays are **sorted
  copies** and that a missing field serialises as `null`. Two callers use this string as a
  change-detection key, so a byte difference silently re-schedules every automation on upgrade.

### 5.5 State owners

No shared state: every function is pure, so there is no owner, no lease, and no ordering
constraint. The scheduler calls it from a single thread. Event ordering is therefore trivially
"whatever order the caller awaits", and there is nothing to diagram beyond the call site:

```
scheduler tick (single-flight, 20 s)
  → computeAutomationNextRunAt(cronExpr, scheduleRule, now)   [sync, pure]
  → claimDue / dispatch / finalise                              [unchanged]
```

---

## 6. Parity harness (the acceptance core)

A `tests/parity.rs` fixture corpus runs **both** implementations over the same inputs and
compares. It is the only thing that makes invariant 3 credible.

### 6.1 Calendar fixtures (mandatory, each a named test)

| Fixture | Input | Asserts |
|---|---|---|
| `local_construction_overflow` | `atTime` with hour 25, minute 70, day 32, month 13 | identical epoch ms to the legacy expression |
| `day_zero_and_negative` | `new Date(y, m, 0)` and `new Date(y, m, -3)` | last-day-of-previous-month and three-days-back agree |
| `feb_29_non_leap_roll` | yearly rule, `monthDays: [29]`, `months: [2]`, from 2025 | rolls to March, `getMonth()` guard skips it, next fire identical |
| `monday_week_start` | anchor on a Sunday and on a Monday | `(getDay() + 6) % 7` Monday-based conversion agrees |
| `dst_spring_forward_gap` | `America/New_York`, `2024-03-10 02:30` | nonexistent local time resolves identically |
| `dst_fall_back_overlap` | `America/New_York`, `2024-11-03 01:30` | ambiguous local time picks the same offset |
| `monthly_mode_weekday` | `monthlyMode: "weekday"` with `weekdays: [1]` | first-weekday-of-month agrees for a leap and a non-leap year |
| `monthly_bound_inclusive` | interval 1200, offset exactly 1200 | the inclusive bound is preserved (legacy comment `:187-188`) |
| `interval_sanitised` | `interval: 0` and `interval: -5` | `Math.max(1, Math.floor(...))` behaviour agrees |
| `schedule_rule_definition_bytes` | sorted vs unsorted weekday arrays, missing fields | identical JSON string, including `null` for absent |

### 6.2 Differential cron corpus (mandatory)

`tests/differential.rs` runs a generated corpus through both the `croner` reference (captured
once into a fixture file, since `croner` is a Node dependency) and the Rust `cron`
implementation, comparing `next_run_at`:

- every `*/N` for N in 1..=59 in the minute field
- `M H * * *` for a spread of minutes/hours, including DST days
- `M H D * *` for D in 1..=31 against months of 28/29/30/31 days
- `M H * * D` for D in 0..=6
- comma lists in each field
- out-of-range and malformed expressions, where both must return `null`

A divergence is a **bug to fix or an enumerated divergence to document**, never a silent
difference. The corpus is generated and committed as a fixture so the test is hermetic.

### 6.3 Gates

- `cargo test -p zcode-cron` — unit + parity + differential, 0 failures
- `pnpm --filter @zcode/rust build:native` emits `zcode-cron.<suffix>.node`
- direct-load smoke: `node -e "const m=require('./packages/rust/zcode-cron.linux-x64-gnu.node'); console.log(Object.keys(m).length)"`
- byte-boundary smoke if any signature moves bytes (invariant 8) — expected **not** to apply,
  since the surface is JSON/`Option<f64>` only; asserted rather than assumed
- `pnpm --dir apps/zcode-cli check`, `pnpm typecheck`, `pnpm lint`,
  `pnpm architecture:check --changed`
- `pnpm --filter @zcode/rust native:inventory` shows `zcode-cron` as **ship** with its consumer
- `pnpm --filter @zcode/desktop prepare:rust-native && …verify` passes with the new crate in the payload
- Tauri: `cargo test --manifest-path apps/zcode-tauri/src-tauri/Cargo.toml` stays green, and the
  new scheduler test proving a missed recurring automation now reschedules

---

## 7. Migration boundary

### 7.1 Deleted

| Removed | Replaced by | Evidence required before listing |
|---|---|---|
| `packages/services/src/session/automationCron.ts` engine body (`:61-358`) | `@zcode/rust/cron` | `rg` shows zero importers outside the two scheduler entry points |
| `packages/services/src/session/automationCronValidation.ts` | `is_valid_cron_expr` | same |
| `"croner": "^10.0.1"` (`packages/services/package.json:27`) | `cron` (Rust) | `pnpm-lock.yaml` updated; no other `croner` importer |
| the `None` workaround in `apps/zcode-tauri/src-tauri/src/lib.rs:167` | real `next_run_at_ms` | the new Tauri test fails without the port |

### 7.2 Kept deliberately

- `packages/shared/src/automation-types.ts` — the wire contract, untouched.
- `packages/desktop/src/scheduler/index.ts` and the services scheduler loop — I/O and ordering.
- The `StaleOneShotAutomationScheduleError` **class**, in TypeScript: the native call returns a
  typed error and the wrapper re-throws the legacy class with its legacy message, so existing
  `catch` sites and their user-facing text are unchanged.

### 7.3 Consumers changed

| File | Change |
|---|---|
| `packages/services/src/session/automationCron.ts` | reduced to a typed wrapper re-exporting the native calls and holding `Date.now()` defaults |
| `packages/desktop/src/scheduler/index.ts:13,146` | import path unchanged (same module specifier) — no edit beyond types |
| `apps/zcode-tauri/src-tauri/src/supervisor/scheduler.rs` | replace the `None` at `lib.rs:167` with a real call; needs `zcode-cron` **linked as an rlib**, not loaded as a `.node` (Tauri is a Rust process — see §10) |

---

## 8. Failure semantics

- **Binary missing / load failure** → `loadNative` throws with the actionable message
  (`loader.ts:76`). No `try/catch` → `croner` (invariant 1). Grep proof in acceptance.
- **Malformed cron expression** → `null` from both implementations, never a throw. Legacy
  `croner` returns no next run; the port must agree, including for the expression shapes
  `croner` accepts but `cron` does not (§6.2).
- **Unsupported `intervalUnit`** → `build_interval_schedule_rule` returns a typed napi error;
  the wrapper re-throws the legacy `Error("Unsupported intervalUnit: …")` so the existing
  validation-layer behaviour is preserved verbatim.
- **Stale one-shot** → typed error carrying the target epoch; the wrapper raises the legacy
  `StaleOneShotAutomationScheduleError`, preserving its message and `name`.
- **No future fire** → `null`. Distinct from an error: the scheduler treats it as "do not
  reschedule".

---

## 9. Divergences

- **D1 — the expression engine changes implementation.** `croner` → `cron`. Accepted with the
  §6.2 differential corpus as the evidence, and any input where the two disagree is either
  fixed or listed here with a rationale. The structured `scheduleRule` path carries **no**
  engine change and is the authoritative path for anything the model creates.
- **D2 — `scheduleRuleDefinition` moves to Rust purely for the single-source reason.** It is not
  a performance port; it moves because it sits in the same module and splitting it would leave
  two definitions of "did the schedule change".
- **D3 — `from` becomes required in the native signature.** Legacy defaults to `Date.now()`;
  the default stays in the TypeScript wrapper so the native function is pure and testable
  (invariant 5).

---

## 10. Shared-file change requests (main session)

| File | Exact change | Why |
|---|---|---|
| `packages/rust/Cargo.toml` | add `chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }` and `cron = "0.15"` to `[workspace.dependencies]` | crate deps. `clock` gives `Local`; `chrono-tz` is **not** needed in the crate (invariant 4 forbids a zone parameter) — the DST fixtures drive the host `TZ` env instead |
| `packages/rust/package.json` | add `"./cron": "./src/cron.ts"` | the wrapper needs a subpath; `check-native-graph` must still pass |
| `apps/zcode-tauri/src-tauri/Cargo.toml` | add `zcode-cron = { path = "../../../../packages/rust/crates/zcode-cron" }` **and** make the crate emit an `rlib` as well as the `cdylib` | Tauri is a Rust process and links the crate directly; it cannot `require()` a `.node`. This mirrors `zcode-rpc-server`, which is `["rlib"]` for exactly this reason |
| `packages/rust/crates/zcode-cron/Cargo.toml` | `crate-type = ["cdylib", "rlib"]` | both consumers |
| root `package.json` | **no change** — `packages/rust` is already in the typecheck project list | verified |
| `architecture-policy.yaml` | **no change** — the `rust` module already owns `packages/rust`; `zcode-cli` already `requires: [rust]` | verified |
| `pnpm-lock.yaml` | regenerates on `croner` removal | main session's call |

---

## 11. Risks

- **R1 — DST and `Date` normalisation parity (the real risk).** §3 lists nine behaviours that a
  naive port gets wrong. `new Date(y, m, d, …)` normalisation and the Feb-29 roll into March
  are the two most likely. Mitigation: §6.1's named fixtures, driven with `TZ` set per test.
  If a fixture cannot be made to agree, **the port does not ship** — a scheduler that fires
  automations an hour off twice a year is worse than no Rust port at all.
- **R2 — `croner` vs `cron` edge cases.** Different libraries, different accepted syntax.
  Mitigation: §6.2's generated differential corpus. Residual risk is accepted and enumerated
  (D1).
- **R3 — the Tauri rlib/cdylib dual build.** `zcode-cron` must compile as both. If the napi
  derive macros make an `rlib` awkward, the fallback is to split the pure logic into a
  `zcode-cron-core` rlib with a thin napi cdylib shell — more crates, same design. Decided
  during implementation, recorded here either way.
- **R4 — `TZ` in tests is process-global.** §6.1's fixtures set `TZ`, which is not
  concurrency-safe. Mitigation: run those tests single-threaded, or use `chrono-tz` in
  test-only code even though the crate itself takes no zone parameter.
- **R5 — the interval carrier is model-influenced input.** `buildIntervalScheduleRule` receives
  `intervalUnit` and `interval` from a model-authored tool call. The port must keep the legacy
  `Math.max(1, Math.floor(interval))` sanitisation exactly, and must not add range limits the
  legacy lacks (that would be a behaviour change dressed as hardening).
- **R6 — no test runner for the TS side.** The parity harness compares against *captured*
  expectations, not a live `croner`, so a `croner` upgrade would not be caught. Mitigation:
  the corpus is regenerated deliberately and the `croner` version is pinned in the spec.
- **R7 — the deleted TS had no tests, so "parity" is against unverified behaviour.** Any legacy
  bug in `automationCron.ts` is faithfully reproduced by the port. That is the correct outcome
  for a migration wave (it is not a behaviour-change window), but it should be stated to
  reviewers rather than discovered by them.

---

## 12. Implementation status

Written after the implementation, in the same commit, and records what the acceptance
checklist established — including what is **not** done.

### Delivered and verified

| Item | Evidence |
|---|---|
| Crate builds; 59 tests pass | `cargo test -p zcode-cron` → 39 unit + 7 date-parity + 4 DST + 9 wire-shape, 0 failed |
| No regressions in sibling crates | `cargo test` over the whole workspace → **431 passed**, 0 failed |
| Live set grew automatically | `zcode-packaging inventory` → **8 shipping**; `zcode-cron` appears with both importers. No packaging-tool change was needed — §5.1's claim that a new consumer is enough held |
| Legacy deleted | `automationCron.ts` engine body and `automationCronValidation.ts` are now boundaries over the binary; `"croner": "^10.0.1"` removed from `packages/services/package.json`. `rg croner` matches only comments and this spec |
| No JS fallback | `automationCron.ts` holds no engine logic; there is no `try { native } catch { croner }`; `loadNative` still throws when the binary is missing |
| End to end through the real `.node` | 15/15 checks via the actual `zcode-rust.linux-x64-gnu.node`: anchor-derived drift resistance, strictly-later semantics, Feb-29 → 2028, one-shot detection incl. the `maxRuns` default, the exact legacy `scheduleRuleDefinition` bytes, and `StaleOneShotAutomationScheduleError` still thrown with its legacy `name` |
| **The Tauri blocker is resolved** | A missed recurring fire now yields a real future timestamp (`Tue Jun 10 2025 10:00:00`) where `lib.rs:167` hardcoded `None` |
| DST parity, in every zone | `cargo test -p zcode-cron` green in `America/New_York`, `Europe/Berlin`, `Australia/Sydney`, `Asia/Kolkata`, `Pacific/Chatham`, `UTC` |
| Repo gates | `pnpm typecheck` exit 0 · `pnpm lint` 0 errors / 72 warnings (unchanged) · `architecture:check --changed` 0 violations · `check-native-graph` OK (invariant 9 intact) |

### Bugs the tests caught — all real, all would have shipped

1. **`at_time` discarded the month rollover.** It took only the *day* component from
   `day_in_month` and rebuilt the date in the original month, so `new Date(2025, 1, 29)`
   produced 29 February instead of 1 March. The yearly branch's `getMonth() !== targetMonth`
   guard depends on the rollover, so a Feb-29 automation would have fired in March instead of
   skipping to the next leap year.
2. **Hour overflow was reduced away.** `hour % 24` turned `new Date(2025, 0, 1, 25, 0)` into
   1 January 01:00 instead of 2 January 01:00 — a silently dropped day. Time components are
   now added as durations so the overflow propagates.
3. **The DST gap resolved to the wrong instant (R1, realised).** A "search outward for the
   nearest valid local time" returns 03:00 for a requested 02:30, because that is the first
   representable instant. ECMAScript uses the *pre-transition* offset, giving 03:30 — verified
   against Node (`Sun Mar 10 2024 03:30:00 GMT-0400`). Every spring-boundary automation would
   have fired half an hour early.
4. **The DST overlap picked the later occurrence (R1, realised).** `LocalResult::Ambiguous`'s
   element order is unspecified; destructuring `(earlier, _)` assumed it. It selected 01:30 EST
   instead of Node's 01:30 EDT, shifting every autumn-boundary automation by an hour. Now the
   earlier epoch is chosen by comparison.
5. **`Math.max` placement differed in two units.** The legacy expressions are
   `Math.max(1, Math.floor(x) + 1)` and `Math.max(0, Math.floor(x) + 1)`; the port had clamped
   only the floor and then added one, so a minute interval fired one step late and an hourly
   one fired an hour late.
6. **`setMinutes(70)` carried into minutes, not hours.** JS `MakeTime` treats the argument as
   minutes-since-midnight, so 09:00 → **10:10** (verified against Node). Reducing to `70 % 60`
   and adding one *minute* gave 09:11.
7. **The reverse cron search returned `None` for every input.** A single forward probe from
   `from - 1s` returns *tomorrow's* fire when today's already passed. Replaced with a bounded
   two-phase search, and the first back-off bound (400 days) was itself too small to reach the
   previous occurrence of a yearly schedule.
8. **`previous_run_at` was inclusive.** `croner`'s `previousRuns` excludes `from` itself, so a
   schedule firing exactly on the boundary reported the wrong occurrence.
9. **The outcome enum's wire shape was wrong in every field at once.** A container-level
   `rename_all = "camelCase"` on the enum renames the *tag value* but leaves inner fields
   snake_cased, producing `{"kind":"staleOneShot","target_at":…}` against a wrapper reading
   `kind === "StaleOneShot"` / `outcome.targetAt`. The failure mode was a **silent `null`**,
   because `undefined?.targetAt` is `undefined` and the wrapper returned it as "no future fire".
   Variant and field names are now spelled out, and `wire_shapes.rs` plus a `lib.rs` unit test
   pin the exact strings.

Four of the original hand-written expectations were also **wrong about JavaScript itself**
and were corrected against Node rather than against memory: `new Date(2025, 1, 0).getDate()`
is 31 (the last day of *January*), `new Date(2025, 0, -3)` is 28 December, the next Monday
after Wednesday 11 June 2025 is the 16th, and a `monthDays: [29]` yearly rule needs a
`from` that actually expires the current candidate. The ground truth is now
**captured from Node** by `scripts/capture-date-ground-truth.mjs` rather than transcribed, and
`parity_dates.rs` asserts the fixture is internally consistent so a mis-capture cannot silently
weaken the suite.

### Not done (deliberately, and not silently)

- ~~**The Tauri host does not call it yet.**~~ **Wired and verified.** See §14.
- **§6.2's differential corpus — BUILT, and it paid for itself.** 530 rows captured from
  `croner@10.0.1` (53 expressions x 10 anchors) and replayed against the Rust engine. The first
  run failed with **44 divergences**; see §13.
- **§10's other shared-file requests** (`apps/zcode-tauri/src-tauri/Cargo.toml`,
  `pnpm-lock.yaml` regeneration) are outstanding.
- **No performance claim.** The spec is explicit that this is a capability port, not a speed
  port, and nothing here should be presented as a speedup. `compute_schedule_rule_next_run_at`
  runs at most once per automation per 20 s tick.

---

## 13. Differential results (§6.2, closing D1)

The corpus is committed at `tests/fixtures/croner-corpus.json`, captured by
`scripts/capture-croner-corpus.mjs` and replayed by `tests/differential.rs`. The test is
hermetic and needs no npm package.

**Result: 530 rows, 526 exact agreements, 4 enumerated divergences.** The test asserts the
divergence set is *exactly* `KNOWN_DIVERGENCES`, so a new regression fails and a stale
exemption also fails.

### What the first run found — 44 divergences, three root causes

1. **Day-of-week numbering differs between the engines (30 rows).** Measured:

   | input | croner | `cron` crate |
   |---|---|---|
   | `0` | Sunday | **rejected** ("must be >= 1") |
   | `1` | Monday | **Sunday** |
   | `7` | Sunday (cron's 0-and-7 alias) | Saturday |

   Untranslated, `0 0 * * 1-5` — "Monday to Friday", which the product accepts and users
   write — silently becomes Sunday to Thursday, and `0 0 * * 0`, a valid Sunday schedule, is
   rejected outright and reports "no future fire". Fixed by `translate_day_of_week`, which
   renumbers 0-6 to the crate's 1-7, maps cron's `7` to the crate's `1` (both are Sunday),
   and **expands step expressions** rather than shifting them: `*/2` is {0,2,4,6} in croner but
   {1,3,5,7} in the crate, so the two sets differ and moving the base is not enough.

2. **`@`-prefixed nicknames were a functional regression (10 rows).** `isValidCronExpr` was
   implemented over croner, so a stored `@daily` both validated *and* scheduled; the crate
   rejects it. Added `NICKNAMES` for `@yearly`/`@annually`/`@monthly`/`@weekly`/`@daily`/
   `@midnight`/`@hourly`, matched case-insensitively.

3. **Out-of-range and boundary day-of-week values (4 rows).** `0 0 * * 8` must be rejected in
   both engines. `0 0 * * 7` is subtler: croner accepts it as Sunday, so it must map to the
   crate's `1`, **not** pass through as `7` (which would select Saturday). A first attempt
   rejected `7` outright on the wrong assumption that cron's range was strictly 0-6; the
   corpus caught that across ten anchors immediately.

### The 4 enumerated divergences

| Expression | Anchor | Root cause |
|---|---|---|
| `0 0 29 2 *` | 2100-03-01 | The crate's search lattice has a **hard year ceiling**: from 2099-03-01 `0 0 1 1 *` resolves to 2100-01-01, but from 2100-03-01 it returns nothing while `* * * * *` still fires. A next fire in 2101+ reports "no future fire" |
| `@annually` | 2100-03-01 | Same ceiling. The nickname itself agrees at every other anchor |
| `0 0 */3 * *` | 2024-02-29T23:59 | `*/N` in **day-of-month** has a different base per engine: croner resolves `*/3` to 4 Mar, the crate to 1 Mar |
| `0 0 */3 * *` | 2028-02-29T12:00 | Same, surfaced by a different anchor |

The day-of-month step case is left divergent on purpose: the deleted `parseCronFields`
explicitly disclaimed step syntax outside the minute field (`automationCron.ts:270-272`:
*"ignore non-inumeric tokens (such as `*/2`)"*), and the only step form the product generates
is `*/N * * * *` in the minute field, where both engines agree. Matching it would mean
emulating croner's undocumented step anchor.

### Corrections to my own expectations

Three more hand-written expectations were wrong and were corrected against croner rather than
against memory: `*/2` in day-of-week from a Wednesday resolves to **Thursday** (the next of
{Sun,Tue,Thu,Sat}), not the following Sunday; `0 0 * * 7` is Sunday, not Saturday; and
`0,7` must collapse to a *single* weekday, which is why deduplication happens after mapping
rather than before.


---

## 14. Tauri wiring (closing §7.3 and §10)

The last step of the wave: the Tauri host now computes the next fire instead of passing `None`.

### R3 resolved — the napi/rlib question

Spec R3 asked whether the `#[napi]` macros would make an `rlib` awkward to link into a
non-Node process, and proposed splitting a `zcode-cron-core` rlib if so. **It was not
necessary.** `zcode-cron` is declared `crate-type = ["cdylib", "rlib"]` and `cargo check` on
`apps/zcode-tauri/src-tauri` links cleanly: the macro-generated symbols are only reachable
through the `.node` entry points, which the Rust host never calls, so nothing dangles. No
crate split was needed.

### The change

`apps/zcode-tauri/src-tauri/src/lib.rs` — the misfire branch of the 20 s tick now computes:

```rust
let next_run_at_ms = match zcode_cron::compute_automation_next_run_at_json(
    &automation.cron_expr,
    automation.schedule_rule.as_deref(),
    now_ms,
) { Ok(next) => next, Err(reason) => { eprintln!(...); None } };
```

The store already read `cron_expr` and `schedule_rule` out of SQLite as strings
(`scheduler_store.rs:241-242`) specifically so the caller could do this, so **no schema or
query change was needed** — only the missing computation.

`compute_automation_next_run_at_json` is a new public, non-napi entry point taking the rule as
JSON, because that is the shape a SQLite column already has; making the host define a Rust
struct only to re-serialise it would be noise. Its parity with the engine is unit-tested, and
an empty/whitespace rule string is treated as **absent** rather than as a parse error, since the
column is nullable and `""` means the same as `NULL`.

**`None` is still passed when the rule is unparseable or has no future fire.** That preserves
the old "leave the schedule alone" behaviour for a row the host cannot reason about, rather
than writing a fabricated timestamp — the reason `next_run_at_ms` is an `Option` in the store's
signature at all. A parse error is logged with the automation id and the reason; a malformed
database column must not take the scheduler process down, so the error is returned rather than
panicking.

### Verification

Two tests in `scheduler_store.rs`, and the first one is a real regression test:

* `a_missed_recurring_fire_is_rescheduled_rather_than_re_claimed_forever` — seeds a recurring
  daily automation whose fire was missed, computes the next run exactly as `lib.rs` does, and
  asserts `next_run_at` advanced. **Verified to fail if `skip_misfire` is called with `None`**
  (temporarily reverted during implementation: `left: Some(999940000), right: Some(1049400000)`
  — the missed fire unchanged versus the computed one), so the pre-port behaviour cannot
  return unnoticed.
* `an_uncomputable_next_run_leaves_the_schedule_untouched_but_releases_the_claim` — the `None`
  path: the schedule is left exactly as it was, and the claim is still released.

`cargo test --lib` in `apps/zcode-tauri/src-tauri`: **64 passed, 0 failed** (was 50 before this
wave). `PORT_STATUS.md` item 3 and the "Recurring misfire does not advance" known issue are both
marked resolved, with the test name cited so a reader can check the claim.

`pnpm-lock.yaml` did not change: the Tauri dependency is a Cargo path dependency, and
`croner` was already removed from `package.json` in the previous commit.
