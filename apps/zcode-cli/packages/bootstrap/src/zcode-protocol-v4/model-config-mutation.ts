import type { ZCodeApp } from "../app/types.js";

const modelConfigMutationTails = new WeakMap<ZCodeApp, Promise<void>>();

/**
 * There is exactly one serialized critical section for the model configuration of a single session App.
 *
 * Provider registry fallback and the user's `switchModelConfig` used to call `setModel` directly
 * each, so the two async chains could interleave into "the catalog fallback that started later
 * overwrites the user's choice", and the event order could also disagree with the runtime's final
 * value. Here every model/thought change is serialized per App identity; a failure only ends the
 * current operation and does not pollute the subsequent tail. The WeakMap does not extend the session lifetime.
 */
export async function runSessionModelConfigMutation<T>(
  app: ZCodeApp,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTail = modelConfigMutationTails.get(app) ?? Promise.resolve();
  const currentOperation = previousTail.catch(() => undefined).then(operation);
  const currentTail = currentOperation.then(
    () => undefined,
    () => undefined,
  );
  modelConfigMutationTails.set(app, currentTail);
  try {
    return await currentOperation;
  } finally {
    if (modelConfigMutationTails.get(app) === currentTail) {
      modelConfigMutationTails.delete(app);
    }
  }
}
