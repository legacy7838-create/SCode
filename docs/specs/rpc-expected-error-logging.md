# Spec: RPC expected-error log classification

Status: active. Owner: main session. Written before the behavior change, per `AGENTS.md:3`.

## 1. Problem

`LoggingChannelServer` / `LoggingChannelClient` (`packages/rpc/src/logging-middleware.ts`) log
**every** rejected `call`/`listen` at the same level, unconditionally:

```
[zcode-server:http] [rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (0.8ms) Error: ZCode Agent runtime is not running.
```

Two of those rejections are normal control flow, not faults:

- `ZCODE_AGENT_RUNTIME_UNAVAILABLE` (`packages/services/src/zcode-agent/zcodeAgent.ts:179`) — a
  background `sessions-index` / `workspace-config` subscription with
  `runtimePolicy: "existing-only"` for a workspace that currently has no running agent runtime.
  The renderer treats it as `dormant` (`sessionsIndexStore.ts` → `handleRuntimeUnavailable`) and
  the service-side syncer treats it as `suspend` (`zcodeTaskIndexSyncer.ts:1457`, `:1498`); neither
  is an incident.
- `ZCODE_AGENT_PROVIDER_NOT_READY` (`packages/shared/src/model-selection-types.ts:1`) — the
  expected "sign in / configure a model first" state.

The generic middleware cannot know this, so `packages/server`'s HTTP entry logs a fault line for
each one. This is the `[zcode-server:http]` noise users see on startup.

## 2. Product rules

1. **Expected errors are classified at the call site, not in the framework.** `packages/rpc` must
   not import `@zcode/services` / `@zcode/shared` error codes (dependency direction). The
   middleware exposes an optional predicate and the caller supplies it.
2. **Default behavior is unchanged.** With no classifier, every rejection is still logged as
   `FAIL`; the middleware does not silently swallow errors for other consumers.
3. **Expected is quiet, not hidden forever.** When `expectedLogger` is supplied the classified
   error goes there instead of the `FAIL` sink; when it is omitted the error is not logged by the
   middleware at all. The handling owner (store / syncer) keeps its own debug/warn record.
4. **The throw is untouched.** Classification only changes logging. The RPC still rejects with the
   same error and the caller's dormant handling is unchanged.
5. **No JavaScript fallback.** The middleware stays renderer-reachable TypeScript with no native
   imports (`rust-native-ports.md` invariant 9).

## 3. Interface

`packages/rpc/src/logging-middleware.ts`:

```ts
export interface RpcLoggingOptions {
  isExpectedError?: (error: unknown) => boolean;
  expectedLogger?: RPCLogger; // omitted => do not log expected errors
}
```

`LoggingChannelServer` and `LoggingChannelClient` take it as an optional third constructor
argument (backwards compatible). Only `packages/server/src/http.ts` widens its `log` call to supply
the classifier for the two codes above; `packages/zcode-server-cli` keeps logging at `debug`
already and is unchanged.

## 4. Out of scope

- No change to the `existing-only` / dormant protocol or to `sessions-index` semantics.
- No new host, stub, or JS fallback for the agent runtime.
- No reclassification of genuine failures: process-spawn errors, handshake failures, and auth loss
  still log as `FAIL`.

## 5. Acceptance

- A rejection carrying `ZCODE_AGENT_RUNTIME_UNAVAILABLE` or `ZCODE_AGENT_PROVIDER_NOT_READY` is not
  emitted as a `FAIL` line by the HTTP RPC logger.
- Any other rejection is still emitted as `FAIL`.
- `packages/rpc` has no import of `@zcode/services` / `@zcode/shared`.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, and
  `node packages/shared/scripts/check-native-graph.mjs` stay green.
