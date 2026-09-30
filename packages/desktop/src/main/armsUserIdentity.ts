interface ArmsUserIdentitySyncDeps {
  /** Device dimension id, reported directly as ARMS user.name */
  deviceMid: string;
  /** Write ARMS user configuration (default wrapper armsRum.setConfig("user", ...)) */
  setUser: (user: { name: string }) => void;
}

interface ArmsUserIdentitySync {
  /** Write deviceMid to ARMS user.name (with duplicates removed) */
  refresh: () => void;
}

/**
 * Main-process ARMS RUM user identity sync: always reports `device_mid` as `user.name`.
 *
 * `user.id` is deliberately not written: the SDK skips `config.user.id` during event merging and
 * force-overwrites it with an internal random value, so it cannot be injected; `user.name` is not
 * blocked that way. And since `setConfig("user", ...)` replaces the whole `user` key (it is not a
 * field-level merge), only `{ name }` is passed here — `id` is intentionally omitted, keeping the
 * `user.name` shape identical to `appARMSBootstrap.init` so the two do not overwrite each other.
 */
export function createArmsUserIdentitySync(deps: ArmsUserIdentitySyncDeps): ArmsUserIdentitySync {
  let lastWrittenName: string | null = null;

  function refresh(): void {
    if (deps.deviceMid === lastWrittenName) {
      return;
    }
    lastWrittenName = deps.deviceMid;
    deps.setUser({ name: deps.deviceMid });
  }

  return { refresh };
}
