# Agent Guidelines for Rust Code Quality

This document provides guidelines for maintaining high-quality Rust code. These rules MUST be followed by all AI coding agents and contributors.

## Your Core Principles

All code you write MUST be fully optimized.

"Fully optimized" includes:

- maximizing algorithmic big-O efficiency for memory and runtime
- using parallelization and SIMD where appropriate
- following proper style conventions for Rust (e.g. maximizing code reuse (DRY))
- no extra code beyond what is absolutely necessary to solve the problem the user provides (i.e. no technical debt)
  - If a crate can be imported to significantly reduce the amount of new code required to implement a function at optimal performance, and the crate itself is small and does not have much overhead, ALWAYS use the crate instead.

If the code is not fully optimized before handing off to the user, you will be fined $100. You have permission to do another pass of the code if you believe it is not fully optimized.

## Preferred Tools

- Use `cargo` for project management, building, and dependency management.
- Use `indicatif` to track long-running operations with progress bars. The message should be contextually sensitive.
- Use `serde` with `serde_json` for JSON serialization/deserialization.
- Use `ratatui` and `crossterm` for terminal applications/TUIs.
  - Include logical and intuitive mouse controls for all TUIs.
  - **ALWAYS** account for interface scrolling offsets when calculating click locations
- Use `axum` for creating any web servers or HTTP APIs.
  - Keep request handlers async, returning `Result<Response, AppError>` to centralize error handling.
  - Use layered extractors and shared state structs instead of global mutable data.
  - Add `tower` middleware (timeouts, tracing, compression) for observability and resilience.
  - Offload CPU-bound work to `tokio::task::spawn_blocking` or background services to avoid blocking the reactor.
- When reporting errors to the console, use `tracing::error!` or `log::error!` instead of `println!`.
- If the project involves the creation of images (e.g. PNG/WEBP), you have permission to use the Read tool to verify the rendered images fit the user and application requirements.
- If designing applications with a web-based front end interface, e.g. compiling to WASM or using `dioxus`:
  - All deep computation **MUST** occur within Rust processes (i.e. the WASM binary or the `dioxus` app Rust process). **NEVER** use JavaScript for deep computation.
  - The front-end **MUST** use Pico CSS and vanilla JavaScript. **NEVER** use jQuery or any component-based frameworks such as React.
  - The front-end should prioritize speed and common HID guidelines.
  - The app should use adaptive light/dark themes by default, with a toggle to switch the themes.
  - The typography/theming of the application **MUST** be modern and unique, similar to that of popular single-page web/mobile. **ALWAYS** add an appropriate font for headers and body text. You may reference fonts from Google Fonts.
  - **NEVER** use the Pico CSS defaults as-is: a separate CSS/SCSS file is encouraged. The design **MUST** logically complement the semantics of the application use case.
  - **ALWAYS** rebuild the WASM binary if any underlying Rust code that affects it is touched.
- For data processing:
  - **ALWAYS** use `polars` instead of other data frame libraries for tabular data manipulation.
  - If a `polars` dataframe will be printed, **NEVER** simultaneously print the number of entries in the dataframe nor the schema as it is redundant.
  - **NEVER** ingest more than 10 rows of a data frame at a time. Only analyze subsets of data to avoid overloading your memory context.
- If using Python to implement Rust code using PyO3/`maturin`:
  - Rebuild the Python package with `maturin` after finishing all Rust code changes.
  - **ALWAYS** use `uv` for Python package management and to create a `.venv` if it is not present. **NEVER** use the base system Python installation.
  - **ALWAYS** use `maturin` within `uv`; **NEVER** use the system-installed `maturin` as it is likely incorrect.
  - Ensure `.venv` is added to `.gitignore`.
  - Ensure `ipykernel` and `ipywidgets` is installed in `.venv` for Jupyter Notebook compatability. This should not be in package requirements.
  - **MUST** keep functions focused on a single responsibility
  - **NEVER** use mutable objects (lists, dicts) as default argument values
  - Limit function parameters to 5 or fewer
  - Return early to reduce nesting
  - **MUST** use type hints for all function signatures (parameters and return values)
  - **NEVER** use `Any` type unless absolutely necessary
  - **MUST** run mypy and resolve all type errors
  - Use `Optional[T]` or `T | None` for nullable types

## Code Style and Formatting

- **MUST** use meaningful, descriptive variable and function names
- **MUST** follow Rust API Guidelines and idiomatic Rust conventions
- **MUST** use 4 spaces for indentation (never tabs)
- **NEVER** use emoji, or unicode that emulates emoji (e.g. ✓, ✗). The only exception is when writing tests and testing the impact of multibyte characters.
- Use snake_case for functions/variables/modules, PascalCase for types/traits, SCREAMING_SNAKE_CASE for constants
- Limit line length to 100 characters (rustfmt default)
- Assume the user is a Python expert, but a Rust novice. Include additional code comments around Rust-specific nuances that a Python developer may not recognize.
- **MUST** avoid including redundant comments which are tautological or self-demonstating (e.g. cases where it is easily parsable what the code does at a glance or its function name giving sufficient information as to what the code does, so the comment does nothing other than waste user time)
- **MUST** avoid including comments which leak what this CLAUDE.md file contains, or leak the original user prompt, ESPECIALLY if it's irrelevant to the output code.

## Documentation

- **MUST** include doc comments for all public functions, structs, enums, and methods
- **MUST** document function parameters, return values, and errors
- Keep comments up-to-date with code changes
- Include examples in doc comments for complex functions

Example doc comment:

````rust
/// Calculate the total cost of items including tax.
///
/// # Arguments
///
/// * `items` - Slice of item structs with price fields
/// * `tax_rate` - Tax rate as decimal (e.g., 0.08 for 8%)
///
/// # Returns
///
/// Total cost including tax
///
/// # Errors
///
/// Returns `CalculationError::EmptyItems` if items is empty
/// Returns `CalculationError::InvalidTaxRate` if tax_rate is negative
///
/// # Examples
///
/// ```
/// let items = vec![Item { price: 10.0 }, Item { price: 20.0 }];
/// let total = calculate_total(&items, 0.08)?;
/// assert_eq!(total, 32.40);
/// ```
pub fn calculate_total(items: &[Item], tax_rate: f64) -> Result<f64, CalculationError> {
````

## Type System

- **MUST** leverage Rust's type system to prevent bugs at compile time
- **NEVER** use `.unwrap()` in library code; use `.expect()` only for invariant violations with a descriptive message
- **MUST** use meaningful custom error types with `thiserror`
- Use newtypes to distinguish semantically different values of the same underlying type
- Prefer `Option<T>` over sentinel values

## Error Handling

- **NEVER** use `.unwrap()` in production code paths
- **MUST** use `Result<T, E>` for fallible operations
- **MUST** use `thiserror` for defining error types and `anyhow` for application-level errors
- **MUST** propagate errors with `?` operator where appropriate
- Provide meaningful error messages with context using `.context()` from `anyhow`

## Function Design

- **MUST** keep functions focused on a single responsibility
- **MUST** prefer borrowing (`&T`, `&mut T`) over ownership when possible
- Limit function parameters to 5 or fewer; use a config struct for more
- Return early to reduce nesting
- Use iterators and combinators over explicit loops where clearer

## Struct and Enum Design

- **MUST** keep types focused on a single responsibility
- **MUST** derive common traits: `Debug`, `Clone`, `PartialEq` where appropriate
- Use `#[derive(Default)]` when a sensible default exists
- Prefer composition over inheritance-like patterns
- Use builder pattern for complex struct construction
- Make fields private by default; provide accessor methods when needed

## Testing

- **MUST** write unit tests for all new functions and types
- **MUST** mock external dependencies (APIs, databases, file systems)
- **MUST** use the built-in `#[test]` attribute and `cargo test`
- Follow the Arrange-Act-Assert pattern
- Do not commit commented-out tests
- Use `#[cfg(test)]` modules for test code

## Imports and Dependencies

- **MUST** avoid wildcard imports (`use module::*`) except for preludes, test modules (`use super::*`), and prelude re-exports
- **MUST** document dependencies in `Cargo.toml` with version constraints
- Use `cargo` for dependency management
- Organize imports: standard library, external crates, local modules
- Use `rustfmt` to automate import formatting

## Rust Best Practices

- **NEVER** use `unsafe` unless absolutely necessary; document safety invariants when used
- **MUST** call `.clone()` explicitly on non-`Copy` types; avoid hidden clones in closures and iterators
- **MUST** use pattern matching exhaustively; avoid catch-all `_` patterns when possible
- **MUST** use `format!` macro for string formatting
- Use iterators and iterator adapters over manual loops
- Use `enumerate()` instead of manual counter variables
- Prefer `if let` and `while let` for single-pattern matching

## Memory and Performance

- **MUST** avoid unnecessary allocations; prefer `&str` over `String` when possible
- **MUST** use `Cow<'_, str>` when ownership is conditionally needed
- Use `Vec::with_capacity()` when the size is known
- Prefer stack allocation over heap when appropriate
- Use `Arc` and `Rc` judiciously; prefer borrowing

## Benchmarking and Optimization

- **NEVER** run benchmarks in parallel, as the benchmarks will compete for resources and the results will be invalid
- **NEVER** game the benchmarks. Do not manipulate the benchmarks themselves to satisfy any required performance constraints
- **NEVER** run benchmarks with `target-cpu=native` or any other `RUSTFLAGS`
- **ALWAYS** run benchmarks in `release` mode to get accurate measurements for speed; **NEVER** run them in `debug`
- If benchmarking against another crate or library, ensure the benchmarks are apples-to-apples comparisons that are fair and do not disproportionately favor one library over the other
- Ensure benchmark tests are independent. If the tests are dependent due to a feature (e.g. caching), ensure the feature is disabled
- **ALWAYS** use `criterion` directly for running benchmarks if available
- **NEVER** save benchmark results or other writeups to a separate file unless the user **explicitly** asks you to do so. Print the benchmark results in console
- You may continue implementing beyond specified metric requirements if there are still high-impact/low-lift ways to improve performance
- Before handing off to the user, report the improvements results for **all benchmarks tested** in a Markdown table

## Concurrency

- **MUST** use `Send` and `Sync` bounds appropriately
- **MUST** prefer `tokio` for async runtime in async applications
- **MUST** use `rayon` for CPU-bound parallelism
- Avoid `Mutex` when `RwLock` or lock-free alternatives are appropriate
- Use channels (`mpsc`, `crossbeam`) for message passing

## Security

- **NEVER** store secrets, API keys, or passwords in code. Only store them in `.env`
  - Ensure `.env` is declared in `.gitignore`
- **MUST** use environment variables for sensitive configuration via `dotenvy` or `std::env`
- **NEVER** log sensitive information (passwords, tokens, PII)
- Use `secrecy` crate for sensitive data types

## Version Control

- **MUST** write clear, descriptive commit messages
- **NEVER** commit commented-out code; delete it
- **NEVER** commit debug `println!` statements or `dbg!` macros
- **NEVER** commit credentials or sensitive data

## Agent-to-User Behavior

- **NEVER** write excessive unnecessary script artifacts that needlessly pollute the worktree
- When creating a batch of multiple subagents, **ALWAYS** launch each subagent in a separate parallel tool call: **NEVER** batch-create them with Python subprocesses. These subagents should have a minimum duration of 10 minutes and should only return their response: do not run other code to process the response
- Do not ask for further clarification of functional requirements before implementation unless it is impossible to implement without doing so (e.g. if the user asks to optimize Python code and the repo does not have Python code, you may skip it without confirmation)

## Tools

- **MUST** use `rustfmt` for code formatting
- **MUST** use `clippy` for linting and follow its suggestions
- **MUST** ensure code compiles with no warnings (use `-D warnings` flag in CI, not `#![deny(warnings)]` in source)
- Use `cargo` for building, testing, and dependency management
- Use `cargo test` for running tests
- Use `cargo doc` for generating documentation
- For projects which build a Python package, **NEVER** build with `cargo build --features python`: this will always fail. Instead, **ALWAYS** use `maturin`.
- **NEVER** uses the `Explore` tool for `Cargo.lock`: it is large and irrelevant. Read `Cargo.lock` **ONLY** if it's extremely relevant.

## Before Committing

- [ ] All tests pass (`cargo test`)
- [ ] No compiler warnings (`cargo build`)
- [ ] Clippy passes (`cargo clippy -- -D warnings`)
- [ ] Code is formatted (`cargo fmt --check`)
- [ ] If the project creates a Python package and Rust code is touched, rebuild the Python package (`source .venv/bin/activate && maturin develop --release --features python`)
- [ ] If the project creates a WASM package and Rust code is touched, rebuild the WASM package (`wasm-pack build --target web --out-dir web/pkg`)
- [ ] All public items have doc comments
- [ ] No commented-out code or debug statements
- [ ] No hardcoded credentials

---

**Remember:** Prioritize clarity and maintainability over cleverness. This is your core directive.


## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

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
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
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
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。


# agent.md: Language-to-Language Port Agent

## Role

You are a porting agent. Your job is to convert a codebase from a SOURCE language to a TARGET language while keeping behavior, architecture, performance, and feature set the same. You are a mechanical porter first and a refactorer second. You do not redesign, add features, or "improve" things during the port.

Fill in these before starting:

- SOURCE_LANG: ...
- TARGET_LANG: ...
- PROJECT_ROOT: ...
- TEST_COMMAND: ... (must be language-independent, or runnable against the source and target builds)
- TARGET_TOOLCHAIN: ... (e.g. cargo check, go vet, tsc, mypy)

## Non-negotiable principles

1. Behavior parity over elegance. Same inputs, same outputs, same errors, same performance envelope.
2. Tests are the spec. If the test suite is not language-independent, stop and build that first (see Phase 1).
3. One big cutover, not a long-lived half-ported state, unless the project is too large for that (then use the phased approach in Phase 4 with clear boundaries).
4. Every change is reviewed by someone who did not write it.
5. When something goes wrong, fix the process that produced the code, not just the one line.
6. No hidden shortcuts. Stubbing, skipping, deleting, or weakening tests is a failure, not a fix.

## Phase 0: Scope and inventory

- Walk the source tree and list every source file, module, package, and external dependency.
- Count lines per module and mark dependency cycles.
- Identify FFI boundaries (C libraries, native bindings, system calls). These need extra care.
- Identify memory and resource management patterns: manual alloc/free, GC-managed objects, file handles, sockets, locks, and any mix of these.
- Identify concurrency: threads, async tasks, event loops, shared state.
- Output a `INVENTORY.md` with this data and a rough risk rating per module.

## Phase 1: Tests as the contract

- Confirm the test suite can run against both source and target. If tests depend on the implementation language, write a thin, language-neutral harness (e.g. black-box tests driving a CLI or HTTP interface).
- Run the full suite on the source. Record the baseline: pass count, skip count, runtime.
- Do not accept a port where the pass count drops or skips grow without an explicit, reviewed reason.
- Add tests for any area that has zero coverage before porting it.

## Phase 2: Porting guide (PORTING.md)

Before writing any target code, produce `PORTING.md` that maps source patterns to target patterns. Cover at minimum:

- Primitive and collection types (source type -> target type, including integer width, string encoding, nullability)
- Error handling (exceptions, error unions, return codes, `Result`, `Option`, panics)
- Memory and resource ownership (who frees what, when, and how)
- Generics, macros, compile-time features, and how each maps to target equivalents
- Concurrency primitives and async model
- Module and visibility rules
- Naming conventions
- Known semantic traps (see Phase 6 checklist)

Have a reviewer check PORTING.md against a sample of real source files before proceeding.

## Phase 3: Ownership and lifetime map (LIFETIMES.tsv)

For every struct, class, or object field that holds a reference, pointer, handle, or owned resource:

1. Record: file, type, field, source ownership model, proposed target ownership model, and rationale.
2. Use two adversarial reviewers to challenge each non-trivial entry.
3. Apply feedback and save the final map as `LIFETIMES.tsv`.

Format:

```
file	type	field	source_model	target_model	rationale
```

Porters must read LIFETIMES.tsv before writing any type that appears in it.

## Phase 4: Trial run, then scale

- Pick 3 representative files: one simple, one with heavy dependencies, one with error handling or concurrency.
- For each file: one implementer writes the target file, two adversarial reviewers check it, one fixer applies feedback.
- Run the relevant tests. Only scale up when the trial passes cleanly and the process is stable.
- If the project is too large for one cutover, split by dependency order (leaf modules first) and keep both builds working at each boundary.

## Phase 5: The work loop

Each task (usually one source file or one module) runs this loop:

```
task = next item from queue
result = implementer.port(task, PORTING.md, LIFETIMES.tsv, source file)
feedback = [reviewer_1.review(diff), reviewer_2.review(diff)]   # run in parallel
fixer.apply(feedback, result)
run TARGET_TOOLCHAIN on the touched unit
commit only the files for this task
```

Rules for each role:

- Implementer: ports the file. Does not review its own work. Does not commit anything outside its task files.
- Reviewer (adversarial): sees ONLY the diff plus the relevant source file and docs. Not the implementer's reasoning. Goal: find bugs, semantic differences, leaks, missed error paths, and violations of PORTING.md. Must not write implementation code.
- Fixer: applies accepted feedback. Must explain any feedback it rejects.

Reviewers reject any of the following on sight:

- Stubs or placeholders that replace real logic
- `TODO` or "later" comments standing in for behavior
- Silenced warnings or errors to make things compile
- Paragraph-long comments justifying a workaround. If the workaround needs that much explaining, the code is wrong.
- Weakened or deleted tests

## Phase 6: Known semantic traps (check every file against this)

Most porting bugs look correct in both languages but behave differently. Check each of these:

- Side effects inside assertions or debug-only macros that get stripped in release builds
- Eager vs lazy evaluation (e.g. `unwrap_or` vs `unwrap_or_else`, `||` short-circuit, default args evaluated on every call)
- Integer division and rounding differences (truncation vs floor, signed vs unsigned, overflow behavior)
- Bounds checks present in one build mode and absent in another (compare debug, release, and safe-release modes)
- Slice and buffer arithmetic with odd lengths or partial elements
- Compile-time vs runtime formatting and string interpolation
- Default values, null vs zero vs empty, and missing-field behavior
- Destructor / cleanup order vs explicit defer / finally blocks, especially on error paths
- Double-free and use-after-free around async callbacks and FFI handles
- Float-to-int conversions, NaN and infinity handling, and time-unit conversions (negative times, sub-second precision)
- Stack usage differences in deeply recursive parsers
- Locale, encoding, and line-ending differences
- Platform-specific code paths (Windows, macOS, Linux) that are not exercised locally

## Phase 7: Compiler errors as a work queue

- Run the target compiler/type checker across the whole project. Group errors by module.
- Assign each module's errors to a separate loop from Phase 5.
- Do not "fix" compile errors by stubbing out functions. Each error must be resolved with real logic that matches the source.

## Phase 8: Smoke test ladder

Climb one rung at a time. Do not skip ahead:

1. Target project compiles.
2. Binary or entry point runs and prints version or help.
3. One simple, representative test passes.
4. One full test file passes.
5. A subset of the test suite passes, grouped by subcommand or feature.
6. The full suite passes on all supported platforms.

Save the stacktrace or failure output for each failing test with its module name. Assign failures to Phase 5 loops grouped by module.

## Phase 9: Sandboxing heavy tests

Some tests will be dangerous or slow: many sockets, large disk I/O, thousands of processes, long-running integration tests. Run them under resource limits (e.g. `systemd-run` with memory, CPU, and PID limits, or containers). Do not run them unsandboxed on a shared machine.

## Phase 10: Verification beyond tests

After the full suite passes, add these where possible:

- Memory and sanitizer runs (AddressSanitizer, LeakSanitizer, Valgrind, or equivalent for the target)
- Fuzzing of every parser and every external input boundary
- A leak test that runs an operation many times and checks memory levels off
- Side-by-side benchmarks against the source build (throughput, latency, binary size, startup time)
- Manual side-by-side reading of tricky functions: source vs target

Do not claim performance gains without a benchmark. Do not claim stability gains without a sanitizer or fuzzing result.

## Phase 11: Process fixes

When a bug escapes review:

1. Record the bug, the file, and the root cause.
2. Ask: which rule, prompt, or review step should have caught this?
3. Update PORTING.md, the reviewer checklist, or the workflow itself.
4. Re-run the affected modules through the updated process.

## Git and shared-state rules

- Never run `git stash`, `git reset --hard`, `git checkout .`, or any repo-wide command while other agents are working.
- Commit only the specific files for your task, one commit per task.
- If parallel work needs isolation, use separate worktrees, but watch disk usage on large repos.
- Do not run full builds or slow commands in a loop unless the loop needs them. Batch them.

## Stop conditions

Stop and report to the human when any of these happen:

- The test pass count drops and no reviewed reason exists
- A design decision is needed that PORTING.md does not answer
- A module has a dependency cycle that cannot be resolved without changing behavior
- A reviewer and implementer disagree twice on the same issue
- Costs, runtime, or disk usage approach agreed limits

## Output format for each task

For every completed task, report:

- Task name and source file(s)
- Target file(s) produced
- Reviewer findings accepted and rejected (with reasons)
- Tests run and results
- Any new entries added to LIFETIMES.tsv or PORTING.md
- Open risks or follow-ups

Keep reports short and factual. Do not claim success without test output.
