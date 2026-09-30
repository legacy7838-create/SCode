import { isBuiltinModelProviderId, isStartPlanModelProviderId } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";

export interface AccountConnectionLoss {
  readonly providerId: string;
  readonly connectionKey: string;
  /**
   * A new account, a new connection, or a recovery to available immediately invalidates old
   * suggestions, including their in-flight queries.
   */
  readonly isCurrent: () => boolean;
}

/**
 * Only the settled state of the same connection is compared; manually picking a plan that has not
 * been activated must not trigger an automatic fallback.
 */
export function createAccountConnectionRefreshObserver(
  notify: (event: AccountConnectionLoss) => void | Promise<void>,
) {
  let disposed = false;
  let latestRevision = -1;
  let key: string | undefined;
  let previous: string | undefined;
  let generation = 0;
  return {
    async accept(view: ProviderSettingsView) {
      if (disposed || view.revision < latestRevision) return;
      latestRevision = view.revision;
      const current = view.providers.find(
        (p) =>
          p.accountState?.current === true &&
          isBuiltinModelProviderId(p.providerId) &&
          !isStartPlanModelProviderId(p.providerId),
      );
      const nextKey = current?.accountState?.connectionKey;
      const next = current?.accountState?.availability;
      if (nextKey !== key) {
        key = nextKey;
        previous = undefined;
        generation++;
      }
      // No guessing will be done when the old Host has no identity facts; unknown will not erase the established baseline.
      if (!key || !current || !next || next === "unknown") return;
      const lost = (previous === "available" || previous === "pending") && next === "unavailable";
      if (next !== previous) generation++;
      previous = next;
      if (!lost) return;
      const eventGeneration = generation;
      try {
        await notify({
          providerId: current.providerId,
          connectionKey: key,
          isCurrent: () =>
            !disposed && generation === eventGeneration && previous === "unavailable",
        });
      } catch (error) {
        // Prompt query failure does not equal a new failure event; unlimited notifications/retries cannot be initiated by repeated Views.
        logger.lifecycle.warn(
          "[AccountConnection] failed to build plan-loss notice, keeping current selection",
          { error },
        );
      }
    },
    invalidate() {
      key = undefined;
      previous = undefined;
      generation++;
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
