export function useRemoteConnectionEntryVisibility(): boolean {
  // The SSH entry previously reused an internal-only gate, so it was hidden in production public-network environments too.
  // But whether SSH is available depends on the target machine, the network path, and credentials — it should not depend on "whether the current client is on the internal network".
  // Remote connection is a general-purpose SSH capability and should not be gated by a retired product's intranet policy.
  return true;
}
