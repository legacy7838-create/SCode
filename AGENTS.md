# Agent Guidelines

Three independent guideline sets. Use only the part that applies to the current project.

- Part 1: Rust code quality
- Part 2: zcode repository rules (Chinese)
- Part 3: Language-to-language porting agent

---

# Part 1: Rust Code Quality

## Core Principles

All code MUST be fully optimized before handoff. Do another pass if it is not.

- Best achievable big-O for memory and runtime.
- Parallelism and SIMD where appropriate.
- Idiomatic Rust, DRY.
- No code beyond what the problem requires (no technical debt). If a small, low-overhead crate significantly reduces the new code needed at optimal performance, use it.

## Preferred Tools

- `cargo` for project management, building, and dependencies.
- `indicatif` for long-running operations; the progress message must be contextual.
- `serde` + `serde_json` for JSON.
- `ratatui` + `crossterm` for TUIs. Provide intuitive mouse controls and ALWAYS account for scroll offsets when calculating click locations.
- `axum` for web servers and HTTP APIs:
  - Async handlers returning `Result<Response, AppError>` to centralize error handling.
  - Layered extractors and shared state structs, not global mutable data.
  - `tower` middleware (timeouts, tracing, compression).
  - CPU-bound work goes to `tokio::task::spawn_blocking` or background services.
- Report errors with `tracing::error!` or `log::error!`, never `println!`.
- When producing images (PNG/WEBP), you may use the Read tool to verify the rendering.
- `polars` for all tabular data.
  - If a dataframe is printed, do not also print its row count or schema.
  - NEVER ingest more than 10 rows of a dataframe at a time.

### Web front ends (WASM, `dioxus`)

- All deep computation MUST run in Rust. NEVER use JavaScript for it.
- Use Pico CSS and vanilla JavaScript. NEVER use jQuery or component frameworks such as React.
- Prioritize speed and common HID guidelines.
- Adaptive light/dark themes by default, with a toggle.
- Modern, distinctive typography: pick header and body fonts (Google Fonts allowed).
- NEVER ship Pico defaults as-is. Use a separate CSS/SCSS file with a design that fits the application.
- ALWAYS rebuild the WASM binary when Rust code that affects it changes.

### Python bindings (PyO3 / `maturin`)

- Use `uv` for package management and to create `.venv` if missing. NEVER use the system Python or system `maturin`.
- Run `maturin` inside `uv`. NEVER build with `cargo build --features python`; it always fails.
- Rebuild with `maturin` after finishing all Rust changes.
- Add `.venv` to `.gitignore`. Install `ipykernel` and `ipywidgets` in `.venv` (not in package requirements).
- Python code: type hints on all signatures, no `Any` unless unavoidable, `T | None` for nullables, no mutable default arguments, run `mypy` and fix all errors.

## Code Style

- Meaningful, descriptive names. Follow the Rust API Guidelines.
- 4 spaces, never tabs. Max line length 100 (rustfmt default).
- `snake_case` functions/variables/modules, `PascalCase` types/traits, `SCREAMING_SNAKE_CASE` constants.
- NEVER use emoji or emoji-like unicode (e.g. checkmarks), except in tests of multibyte handling.
- Assume the user is a Python expert and a Rust novice: comment Rust-specific nuances.
- No tautological comments, and no comments that leak this file or the original prompt.

## Documentation

- Doc comments on all public functions, structs, enums, and methods, covering parameters, return values, and errors.
- Add examples for complex functions. Keep docs in sync with code.

## Types, Errors, and Design

- Use the type system to prevent bugs at compile time: newtypes for semantically different values, `Option<T>` instead of sentinels.
- `Result<T, E>` for fallible operations, propagated with `?`.
- Custom error types with `thiserror`; `anyhow` with `.context()` at the application level.
- NEVER `.unwrap()` in library or production code. Use `.expect()` only for invariant violations, with a descriptive message.
- Functions: single responsibility, borrow instead of owning, 5 or fewer parameters (otherwise a config struct), return early, prefer iterators and combinators, use `enumerate()` and `if let` / `while let`.
- Types: single responsibility, derive `Debug`, `Clone`, `PartialEq` where appropriate, `Default` when sensible, builders for complex construction, private fields with accessors, composition over inheritance-like patterns.
- NEVER use `unsafe` unless necessary; document the safety invariants.
- Call `.clone()` explicitly on non-`Copy` types. Match exhaustively and avoid catch-all `_`. Use `format!` for string formatting.

## Data Modeling Patterns

1. **Enums for exclusive states** (e.g. pending, paid, failed) instead of structs with many optional fields. `match` forces every case to be handled.
2. **Newtypes** (`Money`, `Email`) with validating constructors, so invalid values cannot exist.
3. **Type-state pattern**: generic marker types so invalid transitions do not compile (e.g. `send` exists only on an `Open` connection).
4. **Box large enum variants**, since an enum is as big as its largest variant.

## Memory and Performance

- Avoid unnecessary allocations: `&str` over `String`, `Cow<'_, str>` when ownership is conditional.
- `Vec::with_capacity()` when the size is known. Prefer stack over heap where appropriate.
- Use `Box<[T]>` / `Box<str>` instead of `Vec` / `String` for fixed-size data (drops the capacity field).
- Prefer one contiguous collection with integer offsets over several separate lists.
- Store `Option` for values that usually duplicate another field; allocate only when different.
- Store records in a contiguous byte buffer (wire format) when many small records are kept.
- Use the `HashMap` entry API for a single lookup instead of `contains` + `insert` + update.
- Use `swap_remove` instead of `remove` when element order does not matter.
- Use `rayon` (e.g. `par_lines`) for CPU-bound loops.
- Use `Arc` / `Rc` judiciously; prefer borrowing.

## Concurrency

- Use `Send` and `Sync` bounds appropriately.
- `tokio` for async, `rayon` for CPU-bound parallelism.
- Prefer `RwLock` or lock-free structures over `Mutex` where appropriate.
- Use channels (`mpsc`, `crossbeam`) for message passing.

## Testing

- Unit tests for all new functions and types, using `#[test]`, `#[cfg(test)]`, and `cargo test`.
- Arrange-Act-Assert. Mock external dependencies (APIs, databases, file systems).
- No commented-out tests.

## Imports and Dependencies

- No wildcard imports, except preludes, `use super::*` in test modules, and prelude re-exports.
- Declare dependencies in `Cargo.toml` with version constraints.
- Order imports: standard library, external crates, local modules (let `rustfmt` handle it).

## Benchmarking

- Use `criterion` directly when available. Always run in `release` mode, never in parallel, and never with `target-cpu=native` or other `RUSTFLAGS`.
- NEVER game the benchmarks. Comparisons must be apples-to-apples and tests independent (disable caching features).
- Print results to the console. NEVER save results or writeups to a file unless explicitly asked.
- You may keep optimizing past the target if high-impact, low-effort improvements remain.
- Before handoff, report results for ALL benchmarks tested in a Markdown table.

## Security

- NEVER store secrets in code. Keep them in `.env` (listed in `.gitignore`), loaded via `dotenvy` or `std::env`.
- NEVER log sensitive information (passwords, tokens, PII). Use the `secrecy` crate for sensitive types.

## Version Control and Pre-Commit Checklist

- Clear, descriptive commit messages. NEVER commit commented-out code, debug `println!` / `dbg!`, or credentials.

Before committing:

- [ ] `cargo test` passes
- [ ] `cargo clippy -- -D warnings` passes (no compiler warnings; use `-D warnings` in CI, not `#![deny(warnings)]` in source)
- [ ] `cargo fmt --check` passes
- [ ] All public items have doc comments
- [ ] If Python bindings changed: `source .venv/bin/activate && maturin develop --release --features python`
- [ ] If WASM code changed: `wasm-pack build --target web --out-dir web/pkg`

## Agent Behavior

- Do not litter the worktree with script artifacts.
- Do not ask for clarification before implementing unless implementation is impossible without it.
- Launch each subagent in its own parallel tool call, never batched through Python subprocesses. Subagents run at least 10 minutes and only return their response.
- NEVER read `Cargo.lock` with the `Explore` tool; read it only when it is directly relevant.

---

# Part 2: zcode 仓库规范

## 核心原则

- 新增或修改行为前，先更新对应 spec（目录不存在时按需创建）。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。以下命令从仓库根目录执行：

| 用途             | 命令                                      |
| ---------------- | ----------------------------------------- |
| 类型检查         | `pnpm typecheck`                          |
| Lint             | `pnpm lint` / `pnpm lint:fix`             |
| 格式检查         | `pnpm fmt:check`                          |
| 桌面开发         | `pnpm dev:desktop`                        |
| Web 开发         | `pnpm dev:web`                            |
| 提交前检查       | `pnpm verify:pre-push`（Lint 与架构检查） |
| 架构检查         | `pnpm architecture:check --changed`       |
| 模块阅读包       | `pnpm architecture:context <module-id>`   |
| 未使用依赖与导出 | `pnpm knip`                               |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`     |

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `apps/zcode-cli`：Agent CLI 与运行时。
- `CONTEXT.md`：插件商店领域词汇，修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范，修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`：先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug`：协议原始数据、流式 chunk、逐条工具更新等高频诊断，生产环境不落盘。
- `info`：进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn`：可恢复异常。`error`：崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。

---

# Part 3: Language-to-Language Porting Agent

## Role

You are a porting agent: convert a codebase from SOURCE_LANG to TARGET_LANG while keeping behavior, architecture, performance, and feature set identical. You are a mechanical porter first and a refactorer second. Do not redesign, add features, or "improve" things during the port.

Fill in before starting:

- SOURCE_LANG:
- TARGET_LANG:
- PROJECT_ROOT:
- TEST_COMMAND: (language-independent, or runnable against both builds)
- TARGET_TOOLCHAIN: (e.g. `cargo check`, `go vet`, `tsc`, `mypy`)

## Principles

1. Behavior parity over elegance: same inputs, outputs, errors, and performance envelope.
2. Tests are the spec. If the suite is not language-independent, build a neutral black-box harness first.
3. Prefer one big cutover. If the project is too large, port in dependency order (leaf modules first) and keep both builds working at each boundary.
4. Every change is reviewed by someone who did not write it.
5. When something goes wrong, fix the process that produced it, not just the line.
6. Never stub, skip, delete, or weaken tests to make things pass.

## Phases

**0. Inventory.** List every file, module, package, and external dependency, with line counts and dependency cycles. Flag FFI boundaries, memory/resource patterns (manual alloc, GC, handles, sockets, locks), and concurrency (threads, async, shared state). Write `INVENTORY.md` with a risk rating per module.

**1. Tests as contract.** Run the full suite on the source and record the baseline (pass, skip, runtime). The port must not lower the pass count or raise skips without a reviewed reason. Add tests for uncovered areas before porting them.

**2. PORTING.md.** Before writing target code, map source patterns to target patterns: types (integer width, string encoding, nullability), error handling, ownership and resource management, generics/macros/compile-time features, concurrency, modules and visibility, naming, and the traps in Phase 5. A reviewer checks it against real source files.

**3. LIFETIMES.tsv.** For every field holding a reference, pointer, handle, or owned resource, record `file	type	field	source_model	target_model	rationale`. Two adversarial reviewers challenge each non-trivial entry. Porters read it before writing any listed type.

**4. Trial run.** Port 3 representative files (simple, heavy dependencies, error handling or concurrency) through the work loop and run their tests. Scale up only when the trial passes cleanly.

**5. Work loop.** For each task (one file or module):

```
result   = implementer.port(task, PORTING.md, LIFETIMES.tsv, source)
feedback = [reviewer_1.review(diff), reviewer_2.review(diff)]   # in parallel
fixer.apply(feedback, result)
run TARGET_TOOLCHAIN on the touched unit
commit only this task's files
```

- **Implementer**: ports the file; does not review itself or touch files outside the task.
- **Reviewer** (adversarial): sees only the diff, the source file, and docs, not the implementer's reasoning. Looks for bugs, semantic differences, leaks, missed error paths, and PORTING.md violations. Writes no implementation code.
- **Fixer**: applies accepted feedback and explains any it rejects.

Reviewers reject on sight: stubs or placeholders replacing logic, `TODO` standing in for behavior, silenced warnings or errors, paragraph-long workaround comments, and weakened or deleted tests.

Treat compiler errors as a work queue: group by module and run each through this loop with real logic that matches the source, never stubs.

**6. Semantic traps** (check every file):

- Side effects inside assertions or debug-only macros stripped in release builds
- Eager vs lazy evaluation (`unwrap_or` vs `unwrap_or_else`, short-circuiting, default args)
- Integer division, rounding, signedness, and overflow behavior
- Bounds checks that differ between debug and release modes
- Slice and buffer arithmetic with odd lengths or partial elements
- Compile-time vs runtime formatting and interpolation
- Default values; null vs zero vs empty; missing fields
- Destructor/cleanup order vs `defer`/`finally`, especially on error paths
- Double-free and use-after-free around async callbacks and FFI handles
- Float-to-int conversion, NaN/infinity, time-unit conversion (negative times, sub-second precision)
- Stack usage in deeply recursive parsers
- Locale, encoding, and line endings
- Platform-specific paths (Windows, macOS, Linux) not exercised locally

**7. Smoke test ladder** (one rung at a time):

1. Target compiles.
2. Entry point runs and prints version or help.
3. One simple test passes.
4. One full test file passes.
5. A feature-grouped subset passes.
6. Full suite passes on all supported platforms.

Save the failure output of each failing test with its module name and feed failures back into the work loop by module.

**8. Sandboxing.** Run dangerous or slow tests (many sockets, large disk I/O, thousands of processes) under resource limits (`systemd-run` with memory/CPU/PID limits, or containers), never unsandboxed on a shared machine.

**9. Verification beyond tests.** Where possible: sanitizer/leak runs (ASan, LSan, Valgrind), fuzzing of every parser and external input boundary, a repeat-operation leak test, side-by-side benchmarks against the source build (throughput, latency, binary size, startup), and manual source-vs-target reading of tricky functions. Do not claim performance gains without a benchmark or stability gains without a sanitizer or fuzzing result.

**10. Process fixes.** When a bug escapes review, record the bug and root cause, identify which rule or review step should have caught it, update PORTING.md, the reviewer checklist, or the workflow, and re-run the affected modules.

## Git and Shared State

- Never run `git stash`, `git reset --hard`, `git checkout .`, or any repo-wide command while other agents are working.
- One commit per task, only that task's files.
- Use separate worktrees for isolation (watch disk usage on large repos).
- Batch slow commands instead of looping them.

## Stop and Report When

- The test pass count drops with no reviewed reason.
- A design decision is needed that PORTING.md does not answer.
- A dependency cycle cannot be resolved without changing behavior.
- Reviewer and implementer disagree twice on the same issue.
- Cost, runtime, or disk usage approaches agreed limits.

## Per-Task Report

Keep it short and factual, and never claim success without test output:

- Task name and source/target files
- Reviewer findings accepted and rejected (with reasons)
- Tests run and results
- New entries in LIFETIMES.tsv or PORTING.md
- Open risks or follow-ups