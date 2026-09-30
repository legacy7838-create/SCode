let fallbackSequence = 0;

/**
 * A renderer-local id: main partitions it further by webContents, so cancelling will not hit the
 * participants of other windows by mistake.
 */
export function createCuaPermissionOnboardingOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `cua-onboarding-${randomId}`;
  }
  fallbackSequence += 1;
  return `cua-onboarding-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}
