import { runInContext, type Context } from "node:vm";
import {
  instrumentForContextPersistence,
  parseReplCode,
  rewriteDynamicImportsForRepl,
} from "./instrument.js";

/**
 * ReplExecutor —— the policy seam for "execute + persist across calls" (A-ready).
 *
 * NodeReplSession.run only calls executor.run, so switching the implementation switches the route:
 * - Route B (current): IifeContextExecutor —— instrument top-level declarations → async-IIFE → runInContext.
 * - Route A (future, needs --experimental-vm-modules): SourceTextModuleExecutor —— the harvest flavour of instrument
 *   → SourceTextModule.evaluate → harvest the namespace. The body does not change; only this implementation is replaced.
 *
 * Contract: returns the completion value; throws on error (NodeReplSession's try/catch normalizes it into a structured error).
 * The signal supports cancellation (timeout/stop).
 */
export interface ReplExecutor {
  run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs?: number,
  ): Promise<unknown>;
}

/**
 * The Route B executor: parse the user code, instrument the top-level declarations so they are copied into the persistent context (globalThis),
 * then wrap it in an async-IIFE to get top-level await, and runInContext it in the persistent context.
 *
 * If parsing fails → fall back to the original code (so that a failure in instrument can never crash it); in that case top-level const/let do not persist, but the code still runs.
 */
export class IifeContextExecutor implements ReplExecutor {
  async run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs = 5_000,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    // instrument: globalThis assignment is injected after the top-level declaration. If parse fails, fall back to the original state.
    const rewrittenCode = rewriteDynamicImportsForRepl(code);
    const rewrittenParsed = parseReplCode(rewrittenCode);
    const effectiveCode =
      "ast" in rewrittenParsed
        ? instrumentForContextPersistence(rewrittenCode, rewrittenParsed.ast)
        : rewrittenCode;

    // Wrapped into async IIFE to support top-level await. Dynamically loaded using injected importModule (see NodeReplSession.buildContext),
    // Do not pass importModuleDynamically to avoid triggering the vm's --experimental-vm-modules requirement.
    const wrapped = `(async () => {\n${effectiveCode}\n})()`;
    // Promise race can only cancel asynchronous code that has returned control to the event loop; `while(true){}`
    // The agent thread will be occupied permanently, so that the timer of the outer timeout/AbortSignal has no chance to execute.
    // The VM's own synchronization execution budget is implemented by V8 interrupt check, which can truly interrupt the synchronization infinite loop. The budget only covers
    // In the synchronization segment of runInContext, the asynchronous waiting after await is still responsible for the AbortSignal race.
    const promise = runInContext(wrapped, context, {
      timeout: Math.max(1, Math.trunc(syncTimeoutMs)),
    }) as Promise<unknown>;

    return signal ? await raceAbort(promise, signal) : await promise;
  }
}

function abortReason(signal: AbortSignal): unknown {
  // The reason for AbortSignal.timeout is TimeoutError. Rewriting uniformly to AbortError will make
  // MCP hard timeout is indistinguishable from user-initiated stop, and accurate kernel reset recovery guidance cannot be given.
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "name" in reason) return reason;
  return new DOMException(typeof reason === "string" ? reason : "aborted", "AbortError");
}

/** Races a promise against signal.abort: if aborted, reject immediately with signal.reason; otherwise pass the promise result through. */
function raceAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
