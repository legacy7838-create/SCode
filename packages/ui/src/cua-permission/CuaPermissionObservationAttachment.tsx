import { useEffect } from "react";
import type { CuaAccessibilitySettingsResult, CuaPermissionKind } from "@zcode/shared";
import { requiredCuaPermissionsForRequestAccessStatus } from "@zcode/shared/zcode-protocol-v4";
import {
  isCuaPermissionStatusAvailable,
  type CuaPermissionRestartOptions,
  type CuaPermissionStatusResult,
  type ZCodeAgentCuaPermissionObservation,
} from "@zcode/services";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { shouldRestartHelperAfterCuaPermissionReturn } from "@/lib/cuaPermissionAction.js";
import { createCuaPermissionOnboardingOperationId } from "@/lib/cuaPermissionOnboardingOperation.js";
import { fetchCuaPermissionStatus } from "@/lib/cuaPermissionStatusStore.js";
import { logger } from "@/logger.js";
import { requiredCuaPermissionsForFreshStatus } from "@/settings/cuaPermissionPreparation.js";

interface CuaPermissionPromptDependencies {
  getStatus(): Promise<CuaPermissionStatusResult>;
  confirm(required: CuaPermissionKind[]): Promise<boolean>;
  openOnboarding(required: CuaPermissionKind[]): Promise<CuaAccessibilitySettingsResult>;
  restartHelper(options: CuaPermissionRestartOptions): Promise<{ ok: boolean; reason?: string }>;
  refresh(): void;
  isDisposed?(): boolean;
}

const CUA_PERMISSION_RETRY_DELAY_MS = 500;

function assertCuaPermissionPromptActive(dependencies: CuaPermissionPromptDependencies): void {
  if (dependencies.isDisposed?.()) throw new Error("CUA permission prompt disposed");
}

async function runWithOneRetry<T>(
  dependencies: CuaPermissionPromptDependencies,
  operation: () => Promise<T>,
  failureReason?: (result: T) => string | undefined,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertCuaPermissionPromptActive(dependencies);
    try {
      const result = await operation();
      assertCuaPermissionPromptActive(dependencies);
      const reason = failureReason?.(result);
      if (reason) throw new Error(reason);
      return result;
    } catch (error) {
      if (attempt === 1 || dependencies.isDisposed?.()) throw error;
      await new Promise((resolve) => setTimeout(resolve, CUA_PERMISSION_RETRY_DELAY_MS));
    }
  }
  throw new Error("CUA permission retry exhausted");
}

function cuaPermissionObservationKey(observation: ZCodeAgentCuaPermissionObservation): string {
  const workspaceKey = observation.workspaceIdentity?.trim() || observation.workspacePath;
  const missing = requiredCuaPermissionsForRequestAccessStatus(observation.permissionStatus);
  return [
    workspaceKey,
    observation.sessionId,
    observation.turnId ?? observation.eventId,
    missing.join(","),
  ].join("\0");
}

async function runCuaPermissionPrompt(
  dependencies: CuaPermissionPromptDependencies,
): Promise<void> {
  const readMissing = async () => {
    const status = await runWithOneRetry(dependencies, dependencies.getStatus);
    return isCuaPermissionStatusAvailable(status)
      ? requiredCuaPermissionsForFreshStatus(status)
      : [];
  };
  const beforeConfirm = await readMissing();
  if (beforeConfirm.length === 0) return;
  assertCuaPermissionPromptActive(dependencies);
  if (!(await dependencies.confirm(beforeConfirm))) return;
  assertCuaPermissionPromptActive(dependencies);

  // Reason: Authorization may have been obtained from another window while the confirmation box is staying. The Helper true value must be read again before opening the settings.
  const afterConfirm = await readMissing();
  if (afterConfirm.length === 0) return;
  const result = await runWithOneRetry(
    dependencies,
    () => dependencies.openOnboarding(afterConfirm),
    (value) =>
      !value.success && !value.canceled
        ? `CUA permission onboarding failed: ${value.error ?? "unknown"}`
        : undefined,
  );
  if (result.canceled) return;
  if (shouldRestartHelperAfterCuaPermissionReturn(result)) {
    // Reason: When the Helper fails to restart, it can only retry the restart itself. Repeatedly opening system settings will interrupt user operations.
    await runWithOneRetry(
      dependencies,
      () =>
        dependencies.restartHelper({
          reason: "permission_granted",
          ...(result.sessionId ? { onboardingSessionId: result.sessionId } : {}),
        }),
      (value) => (value.ok ? undefined : `CUA Helper restart failed: ${value.reason ?? "unknown"}`),
    );
  }
  if (result.success && result.returnedFromSettings) {
    assertCuaPermissionPromptActive(dependencies);
    dependencies.refresh();
  }
}

export function CuaPermissionObservationAttachment() {
  const services = useServices();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { intl } = useZCodeIntl();

  useEffect(() => {
    const permissionService = services.cuaPermissionService;
    if (
      !permissionService ||
      !platform.openCuaPermissionOnboarding ||
      typeof services.zcodeAgentService.onDynamicCuaPermissionObservation !== "function"
    ) {
      return;
    }

    const handled = new Set<string>();
    const pending = new Set<string>();
    let chain = Promise.resolve();
    let activeOperationId: string | null = null;
    let disposed = false;
    const subscription = services.zcodeAgentService.onDynamicCuaPermissionObservation()(
      (observation) => {
        const missing = requiredCuaPermissionsForRequestAccessStatus(observation.permissionStatus);
        const key = cuaPermissionObservationKey(observation);
        if (disposed || missing.length === 0 || handled.has(key) || pending.has(key)) return;
        pending.add(key);

        chain = chain.then(async () => {
          if (disposed) return;
          try {
            await runCuaPermissionPrompt({
              getStatus: () =>
                permissionService.getStatus(
                  observation.workspacePath,
                  observation.workspaceIdentity,
                  { includeFunctionalProbes: false },
                ),
              confirm: () =>
                confirmDialog({
                  title: intl.formatMessage({ id: "cuaPermission.live.title" }),
                  description: intl.formatMessage({ id: "cuaPermission.live.description" }),
                  confirmLabel: intl.formatMessage({ id: "cuaPermission.live.confirm" }),
                  cancelLabel: intl.formatMessage({ id: "cuaPermission.live.cancel" }),
                }),
              openOnboarding: async (required) => {
                const operationId = createCuaPermissionOnboardingOperationId();
                activeOperationId = operationId;
                try {
                  return (
                    (await platform.openCuaPermissionOnboarding?.({
                      operationId,
                      initialPermission: required[0],
                      requiredPermissions: required,
                    })) ?? { success: false, error: "unavailable" }
                  );
                } finally {
                  if (activeOperationId === operationId) activeOperationId = null;
                }
              },
              restartHelper: (options) =>
                permissionService.restartHelper(
                  observation.workspacePath,
                  observation.workspaceIdentity,
                  options,
                ),
              refresh: () =>
                fetchCuaPermissionStatus({
                  service: permissionService,
                  workspacePath: observation.workspacePath,
                  workspaceIdentity: observation.workspaceIdentity,
                  options: { includeFunctionalProbes: false },
                }),
              isDisposed: () => disposed,
            });
            if (disposed) return;
            // Reason: Only normal final states (including user cancellation) can be deduplicated; exceptions must allow the same observation to be processed again.
            handled.add(key);
            if (handled.size > 2_000) {
              const oldest = handled.values().next().value;
              if (typeof oldest === "string") handled.delete(oldest);
            }
          } catch (error: unknown) {
            if (!disposed) logger.warn("CUA permission onboarding failed", { error });
          } finally {
            pending.delete(key);
          }
        });
      },
    );
    return () => {
      // Reason: Close the life cycle boundary first to prevent queued tasks from continuing to trigger old workspace side effects after the subscription is released.
      disposed = true;
      subscription.dispose();
      if (activeOperationId) platform.cancelCuaPermissionOnboarding?.(activeOperationId);
    };
  }, [confirmDialog, intl, platform, services]);

  return null;
}
