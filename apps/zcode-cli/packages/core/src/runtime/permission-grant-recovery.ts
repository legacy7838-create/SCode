import type { AgentRuntimeInternal } from "./internal.js";

// The second permission/queue is not saved, and only recovery actions in which the transaction has been submitted but the event has not been released are recorded.
export const unpublishedPermissionGrants = new WeakMap<
  AgentRuntimeInternal,
  {
    interactionId: string;
    recover: () => Promise<string>;
  }
>();

export async function recoverPendingPermissionGrant(runtime: AgentRuntimeInternal): Promise<void> {
  await unpublishedPermissionGrants.get(runtime)?.recover();
}
