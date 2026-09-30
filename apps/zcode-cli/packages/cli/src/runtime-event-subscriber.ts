// The ability to read "cross-turn session event subscription" on the runtime.
//
// It is a separate module because the consumer has two different venues: headless (`prompt-command.ts`) and TUI
// (`tui-prompt-handler.ts` → `tui-session-event-relay.ts`). Capability readers need to be independent of any
// venue: If placed in the headless exclusive module, the TUI side has to import a module named headless.
// A Reader Called Headless – The name lies about the behavior. It only answers "Can this runtime be subscribed across rounds?"
import type { SessionEvent } from "@zcode/contracts";

/**
 * Dynamically read a function member off an `unknown`.
 *
 * Taking an `unknown` and probing properties dynamically is **not** about defending against a real `AgentRuntime` (all these
 * members are required there), but because `RunDependencies.createZCodeApp` is a public injection point (the comment in
 * cli-types.ts says "tests, embedders") and a stand-in runtime can be any shape at all. Writing `?.` against required members
 * would be judged by TS as an always-true condition — so the boundary lives here, expressed as one explicit dynamic read.
 */
export const readRuntimeFunction = (
  source: unknown,
  key: string,
): ((...args: never[]) => unknown) | undefined => {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "function" ? (value as (...args: never[]) => unknown) : undefined;
};

type RuntimeEventSubscriber = (sink: {
  onSessionEvent: (event: SessionEvent) => void;
}) => () => void;

/**
 * Read out the runtime's cross-turn event subscription.
 *
 * **No silent degradation**: when the subscription cannot be obtained, return `undefined` and let the caller fall back to per-turn
 * `onEvent` (visible within a single turn, as before this change). That is the honest answer for "this host does not have that
 * capability", rather than pretending the subscription succeeded.
 */
export const readRuntimeEventSubscriber = (
  runtime: unknown,
): RuntimeEventSubscriber | undefined => {
  const subscribe = readRuntimeFunction(runtime, "subscribeEvents");
  if (!subscribe) return undefined;
  return (sink) => {
    const detach = (subscribe as (s: unknown) => unknown).call(runtime, sink);
    return typeof detach === "function" ? (detach as () => void) : () => undefined;
  };
};
