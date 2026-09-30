/**
 * storage module manifest: the disk usage scan and cleanup behind the settings page's "Storage
 * Management". The dependency declaration stays consistent with architecture-policy.yaml; only
 * contract.ts is exposed externally.
 */
export const storageModule = {
  id: "storage",
  requires: ["shared", "rpc", "services"],
  provides: ["storage-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
