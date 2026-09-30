# Agent Instructions

This is the TypeScript Node.js Coding Agent CLI, supporting mainstream models and operating systems. General working rules follow the [root AGENTS.md](../../AGENTS.md); this file supplements CLI rules. Node.js and package manager versions are governed by the repository root [mise.toml](../../mise.toml) and [package.json](../../package.json).

## Working Standards (Most Important)

- Before adding or modifying behavior, write or update the corresponding spec first, defining product rules, state owners, interfaces, and acceptance scenarios before implementing code. Prioritize reusing existing documentation; create documentation and directories as needed when missing; do not assume a fixed-version design directory exists.
- Second, test cases are critical; they prove results match expectations.
- Leave a good trail: after adding features, leave new documentation; after bugfixes, write the cause of the bug in comments.
- For an agent-friendly project, leave good logs or interfaces so the agent can fully take over operations.
- Long-task priority: the core agent loop is designed by default for sustainably running complex tasks; do not use tool call count as a hard stop. Resource and security boundaries should be handled by explicit conditions such as automatic compaction at token/context limits, user cancellation, permission denial, tool timeout, output truncation, and provider retry limits.
- A single source file should not exceed 400 lines by default; when exceeded, prioritize splitting modules by high cohesion and low coupling; do not keep piling responsibilities into a large file.
- Constants such as strings and numbers should be extracted as named variables or constants; do not scatter literals directly in business logic, to enable single-point modification and unified maintenance.
- Before modifying database structure, confirm the approach with the module maintainer, clarifying migration, compatibility, and rollback strategies.
- Keyboard operation first; all core logic should be operable via keyboard. Mouse operation is a value-added capability.

## Tool Standards

- Before interacting with the operating system, consider supporting Windows, Mac, and Linux simultaneously.
- Keep the default release path as the standard Node.js CLI packaging approach.
- Project-specific environment variables should uniformly use the `ZCODE_` prefix, but do not casually add new environment variables; before adding, you must first define the purpose, priority, error behavior, and test coverage in the corresponding feature's spec. Capabilities that can be expressed via configuration files, CLI parameters, or session configuration should preferably not be made into environment variables.

## Open Source Content and Sensitive Information

- Project licensing and attribution notices are in the repository root [LICENSE](../../LICENSE), [NOTICE.md](../../NOTICE.md), and [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md). Before introducing third-party code, documentation, prompts, or materials, confirm the source, license, and usage rights; retain copyright, attribution, and modification notices per the applicable license; do not delete still-applicable attribution notices for open source cleanup.
- Documentation, examples, test data, logs, and commit messages must not contain real credentials, user privacy, internal service addresses, personal working directories, or unauthorized public content; examples should use fictional data and placeholder values.
- Before release, verify the actual delivery scope; when Git history is included, also check historical content. Deletions or replacements in the current files do not mean historical records have been cleaned.

## Cross-Platform Compatibility Principles

- All features must by default be designed for Windows, macOS, and Linux simultaneously; do not implement based solely on the current development machine's OS behavior.
- For path handling, prefer Node.js standard library cross-platform APIs such as `path`, `url`, `fs`; do not hand-write path separators, absolute path prefixes, newline characters, or temporary directory locations.
- When running external commands, prefer the parameter array form of `child_process.spawn` / `execFile`; avoid relying on shell string concatenation, POSIX-specific syntax, pipes, redirections, or built-in commands.
- When needing to invoke system commands, editors, shells, package managers, or executables, consider Windows `.cmd` / `.exe`, space paths, parameter escaping, environment variable case, and shell differences.
- File system logic should consider case sensitivity differences, permission model differences, symlink support differences, executable bit differences, newline character differences, and path length limits.
- Terminal interaction should be based on capability detection rather than assuming fixed terminal characteristics; colors, TTY, Unicode, interactive input, window size, and signal handling all need fallback paths for non-interactive or insufficient-capability scenarios.
- When involving user directories, cache directories, configuration directories, temporary directories, and project directories, obtain them through explicit cross-platform resolution logic; do not hardcode Unix-style directory structures.
- When adding system-interaction capabilities, add or update tests covering cross-platform differences; behaviors that cannot be verified on the current system must explicitly note remaining risks in implementation and documentation.

## Module Boundaries and Interface Contracts

- Interactions between modules must be completed through explicit, bounded, and stable interfaces.
- Each module should be independently understandable, testable, and replaceable, and provide strict type declarations, interface definitions, or schema declarations externally.
- Modules are not directly coupled to each other's implementations but are scheduled through standardized contracts. Callers should not depend on the internal implementation, directory structure, implicit global state, or undeclared conventions of the called module.
- Contracts exposed by modules should clearly describe capabilities, inputs, outputs, error forms, state changes, and side effects.
- When data crosses process, storage, network, plugin, tool call, or LLM boundaries, prefer runtime-validatable schema descriptions rather than just TypeScript types.
- When adding new inter-module interactions, first complete the interface contract, then implement the concrete logic.

## External I/O Boundary Convergence

- All external side effects must be uniformly observable, approvable, cancelable, retryable, queueable, auditable, and testable. Business logic only expresses intent and does not directly touch the external world.
- All external I/O must converge into explicit infrastructure layers or adapters, including network requests, file system reads/writes, subprocess calls, environment variable reads, terminal I/O, caches, databases, system clipboard, and external service access.
- Except for the entry layer, infrastructure layer, and adapters, business modules must not directly call low-level I/O APIs such as `fetch`, `http`, `fs`, `child_process`, `process.env`; they should depend on interfaces, services, or adapters defined within the project.
- I/O adapters must provide stable type declarations or schemas externally, clearly defining inputs, outputs, error types, timeouts, cancellation, retry semantics, idempotency, and side effect scope.
- Network access should go through a unified request entry point, facilitating centralized management of timeouts, retries, backoff, authentication, proxies, custom certificates, rate limiting, logging, auditing, and error normalization.
- File reads/writes should go through a unified file system entry point, facilitating centralized management of atomic writes, concurrency control, temporary files, queued writes, permission errors, path normalization, and cross-platform differences.
- Subprocess execution should go through a unified execution entry point, facilitating centralized management of sandboxing, permission approval, environment variables, timeouts, cancellation, output truncation, streaming output, and exit code normalization.
- When I/O operations need to be asynchronous, queued, retried, degraded, or audited, this should be handled at the I/O boundary layer, not scattered into business logic.

## Tool and Side Effect Contracts

- Every tool should declare explicit `inputSchema`, `outputSchema`, whether it is read-only, whether it is destructive, whether it is concurrency-safe, maximum output size, timeout, cancellation semantics, and permission requirements.
- The side effect scope of tools should be explicitly declared, such as `none`, `workspace`, `git`, `network`, `system`. Permission systems, sandboxing, and approval flows should read these declarations rather than relying on ad-hoc guesses at call sites.
- Tools with side effects should declare idempotency and recoverability strategies where possible, to facilitate subsequent implementation of retries, rollbacks, queued execution, and failure recovery.
- Large tool results should not be directly fed back into model context; they should be persisted to disk or enter artifact/storage, with only summaries, previews, and traceable references returned.
- External extensions such as MCP, plugins, and subagents must be integrated through capability declarations, schema validation, namespace isolation, and permission convergence; they should not directly gain internal module implementation capabilities.

## Session, Configuration, and Observability

- The coding agent CLI should treat session, message, tool call, permission, checkpoint, queue, and pending state as first-class state objects, supporting recovery, forking, rollback, and concurrent sessions.
- The TUI is only responsible for input collection, layout rendering, and temporary interaction state, such as cursor, input box, scroll position, and current popup selection; business state such as session, mode, model, tool, todo, permission, checkpoint must not be stored in the TUI layer and must be stored by server/bootstrap/core/session and delivered through explicit interfaces or session events.
- Collapse/expand indicators in the TUI uniformly use `+`/`-` (collapsed is `+`, expanded is `-`); do not use `v` and `>`.
- User-interaction-related capabilities such as confirmation, selection, input, progress, and error recovery should be designed as stable interaction request/response interfaces or session events for TUI and ZCode Protocol V4 clients; different clients are only presentation and transport adaptation layers and should not hardcode interaction flows in a single frontend.
- All task execution must carry a propagatable `traceId`. `traceId` by default corresponds to the complete task chain of a top-level session; sub-sessions, subagents, retried tasks, background queue tasks, and async I/O created within a session should all belong to the same `traceId`.
- `traceId` sits above `sessionId`; `sessionId`, `turnId`, `messageId`, `toolCallId`, `spanId`, `parentSpanId`, etc. should serve as structured sub-identifiers under `traceId`, used to reconstruct the complete call chain.
- All modules, services, adapters, tool runtimes, provider clients, I/O adapters, and permission judgment logic should receive and continue to propagate the unified execution context, and must not discard, override, or temporarily generate unassociated `traceId` midway.
- Any asynchronous task, tool call, external I/O, cross-module call, or sub-session that cannot be associated with a `traceId` is considered unobservable behavior and should be avoided.
- Providers, models, MCP, storage, network proxies, and certificates should all be integrated through adapters; session-core should not hardcode specific vendors, transport protocols, or deployment environments.
- Configuration needs explicit hierarchy and priority, such as system, user, project, session, CLI parameters, and environment variables; security-related configuration should be able to trace its source.
- Embrace the `.agents Protocol` and `AGENTS.md` conventions; in subsequent designs, especially for configuration discovery, configuration reading, priority resolution, and related capabilities, compatibility with `.agents Protocol` is required by default.
- Retain debugging and observability entry points from the first version, covering model requests, context composition, token/cost, tool calls, I/O, permission judgment, retries, queue backlog, and queue drops.
- Logs, traces, and debug output should avoid leaking keys, tokens, privacy data, and complete user content; when highly sensitive information is needed, it must explicitly enter a controlled debug path.

## Error Handling First

- Errors are first-class design objects. When adding features, prioritize failure paths, error ownership, propagation methods, and final user prompts.
- By default, let errors bubble up until they reach the layer truly capable of handling them. Do not casually swallow errors in low-level modules, only print logs and continue execution, or prematurely convert errors into plain strings.
- Only catch errors when you can recover, retry, degrade, supplement context, convert to user-actionable prompts, or are at the CLI entry boundary.
- When throwing or wrapping errors, preserve the original error cause and supplement necessary context to avoid losing the call chain and system error information.
- Users can perceive the deep state of the system; errors, waiting, retries, permissions, models, tools, and I/O state should be exposed upward along the call chain to user interfaces such as CLI/TUI, while avoiding leaking keys, privacy, and complete raw content.
- Low-level business modules should not directly call `process.exit`, directly output errors to the terminal, or decide the final exit code; the CLI entry layer is responsible for uniformly formatting errors, outputting prompts, and setting exit codes.
- Do not rely on error text for flow judgment; when error types need to be distinguished, use stable error types, error codes, or structured fields.
- Tests should cover key failure paths, especially common CLI errors such as missing configuration, insufficient permissions, network failures, file system exceptions, invalid user input, and external command failures.

## Commit Standards

- Create a separate commit for each feature-level change.
- Do not mix unrelated features, refactoring, dependency updates, and formatting adjustments in the same commit.
- Keep commits small enough for independent review.
- When a feature's changes span multiple files, commit those files together.
- If a task requires multiple feature-level changes, split them into multiple independent commits in the order they should be reviewed.

## Verification

- Before completing code changes, run `pnpm typecheck` and `pnpm lint` from the repository root; when CLI code is involved, also run `pnpm --dir apps/zcode-cli typecheck` and `pnpm --dir apps/zcode-cli lint`.
- Test entry points are based on the target package's current `package.json` and actual test files; do not assume a unified test command exists; behavior changes should run corresponding tests, interaction changes should cover E2E scenarios.
- Honestly record executed commands, results, and unverified scope; missing test entries, existing failures, or environmental constraints must not be reported as passing.
