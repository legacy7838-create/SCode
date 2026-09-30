export interface RemoteAssetNetworkPort {
  fetch: typeof globalThis.fetch;
}

export function resolveRemoteAssetFetch(
  network: RemoteAssetNetworkPort | undefined,
): typeof globalThis.fetch {
  // Desktop Host's remote resource download used global fetch directly, bypassing the settings page proxy.
  // The standalone server does not have the Desktop settings authority and retains the existing contract for direct connections when not injected.
  return network?.fetch ?? globalThis.fetch.bind(globalThis);
}
