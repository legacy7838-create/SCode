interface SettingUpdatedEvent {
  readonly keys: readonly string[];
}

interface AccountProviderInvalidationOptions {
  readonly onDidUpdateSetting: (listener: (event: SettingUpdatedEvent) => void) => () => void;
  readonly refresh: (reason: string) => Promise<unknown>;
}

const ACCOUNT_PROVIDER_SETTING_KEYS = new Set([
  "providerFamilyDomain",
  "providerFamilyConnectionSelections",
  "zcodeEndpointOrigin",
]);

/**
 * Converges the Settings changes that affect account connection selection into an
 * AccountProviderService refresh.
 *
 * OAuth login, logout and completed purchases refresh the Account Source directly from their
 * own business flows; we no longer subscribe to events from the retired legacy Registry, which
 * would reintroduce a parallel source of truth.
 */
export function bindAccountProviderInvalidation(
  options: AccountProviderInvalidationOptions,
): () => void {
  const requestRefresh = (reason: string): void => {
    void options.refresh(reason).catch(() => {
      // AccountProviderService uniformly records failures through onDidRefreshError and retains last-known-good.
    });
  };
  const disposeSetting = options.onDidUpdateSetting((event) => {
    const keys = event.keys.filter((key) => ACCOUNT_PROVIDER_SETTING_KEYS.has(key));
    if (keys.length > 0) {
      requestRefresh(`settings:${keys.join(",")}`);
    }
  });

  return () => {
    disposeSetting();
  };
}
