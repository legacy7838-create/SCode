import { useEffect, useState, type MouseEvent } from "react";
import { ChevronDown, UploadCloud } from "lucide-react";
import type { RemoteTarget } from "@zcode/shared";
import type {
  IMcpSyncService,
  ISkillSyncService,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteMcpSyncDialog } from "@/settings/RemoteMcpSyncDialog.js";
import { RemoteSkillSyncDialog } from "@/settings/RemoteSkillSyncDialog.js";

type RemoteSyncClientMode = "desktop-continuous" | "web-remote-replayable";
const REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS = 15_000;

export class RemoteSyncPreflightTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Remote sync preflight timed out after ${timeoutMs}ms`);
    this.name = "RemoteSyncPreflightTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RemoteSyncPreflightTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function isRemoteSyncPreflightTimeoutError(
  error: unknown,
): error is RemoteSyncPreflightTimeoutError {
  return error instanceof RemoteSyncPreflightTimeoutError;
}

export async function runRemoteSyncPreflightWithTimeout<T>(
  action: () => Promise<T>,
  timeoutMs = REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS,
): Promise<T> {
  return withTimeout(action(), timeoutMs);
}

export function shouldStartRemoteSyncOperation({
  inFlight,
  selectedCount,
}: {
  inFlight: boolean;
  selectedCount: number;
}): boolean {
  return !inFlight && selectedCount > 0;
}

export function shouldShowRemoteSyncActions(
  remoteTarget: RemoteTarget | null,
  clientMode?: RemoteSyncClientMode,
): boolean {
  return Boolean(remoteTarget) && clientMode !== "web-remote-replayable";
}

export function useRemoteSkillSyncAvailable(
  localSkillSyncService?: ISkillSyncService | null,
  remoteSkillSyncService?: ISkillSyncService | null,
  remoteTarget?: RemoteTarget | null,
  clientMode?: RemoteSyncClientMode,
): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    if (
      !shouldShowRemoteSyncActions(remoteTarget ?? null, clientMode) ||
      !localSkillSyncService ||
      !remoteSkillSyncService
    ) {
      setAvailable(false);
      return;
    }

    void withTimeout(
      Promise.all([
        remoteSkillSyncService.checkRemoteUserSkillWriteAccess(),
      ]),
      REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS,
    )
      .then(([remote]) => {
        if (!active) return;
        setAvailable(remote.ok);
      })
      .catch(() => {
        if (!active) return;
        setAvailable(false);
      });

    return () => {
      active = false;
    };
  }, [clientMode, localSkillSyncService, remoteSkillSyncService, remoteTarget]);

  return available;
}

export function useRemoteMcpSyncAvailable(
  localMcpSyncService?: IMcpSyncService | null,
  remoteMcpSyncService?: IMcpSyncService | null,
  remoteTarget?: RemoteTarget | null,
  clientMode?: RemoteSyncClientMode,
): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    if (
      !shouldShowRemoteSyncActions(remoteTarget ?? null, clientMode) ||
      !localMcpSyncService ||
      !remoteMcpSyncService
    ) {
      setAvailable(false);
      return;
    }

    void withTimeout(
      Promise.all([
        remoteMcpSyncService.checkRemoteUserMcpWriteAccess(),
      ]),
      REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS,
    )
      .then(([remote]) => {
        if (!active) return;
        setAvailable(remote.ok);
      })
      .catch(() => {
        if (!active) return;
        setAvailable(false);
      });

    return () => {
      active = false;
    };
  }, [clientMode, localMcpSyncService, remoteMcpSyncService, remoteTarget]);

  return available;
}

export function RemoteSyncMenuItems({
  canSyncSkills,
  canSyncMcp,
  onOpenSkillSync,
  onOpenMcpSync,
  stopMouseDownPropagation = false,
  mcpDisabled = false,
}: {
  canSyncSkills: boolean;
  canSyncMcp: boolean;
  onOpenSkillSync: () => void;
  onOpenMcpSync: () => void;
  stopMouseDownPropagation?: boolean;
  mcpDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const handleMouseDown = stopMouseDownPropagation
    ? (event: MouseEvent) => {
        event.stopPropagation();
      }
    : undefined;

  return (
    <>
      {canSyncSkills ? (
        <DropdownMenuItem onMouseDown={handleMouseDown} onSelect={onOpenSkillSync}>
          <UploadCloud className="size-3.5" />
          {intl.formatMessage({ id: "settings.skills.remoteSync.open" })}
        </DropdownMenuItem>
      ) : null}
      {canSyncMcp ? (
        <DropdownMenuItem
          disabled={mcpDisabled}
          onMouseDown={handleMouseDown}
          onSelect={onOpenMcpSync}
        >
          <UploadCloud className="size-3.5" />
          {intl.formatMessage({ id: "settings.mcp.remoteSync.open" })}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

export function RemoteSyncDropdownButton({
  canSyncSkills,
  canSyncMcp,
  mcpDisabled = false,
  onOpenSkillSync,
  onOpenMcpSync,
}: {
  canSyncSkills: boolean;
  canSyncMcp: boolean;
  mcpDisabled?: boolean;
  onOpenSkillSync: () => void;
  onOpenMcpSync: () => void;
}) {
  const { intl } = useZCodeIntl();

  if (!canSyncSkills && !canSyncMcp) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="sm" className="gap-1">
          <UploadCloud className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.remoteSync.open" })}
          <ChevronDown className="size-3.5 text-foreground-subtle" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <RemoteSyncMenuItems
          canSyncSkills={canSyncSkills}
          canSyncMcp={canSyncMcp}
          mcpDisabled={mcpDisabled}
          onOpenSkillSync={onOpenSkillSync}
          onOpenMcpSync={onOpenMcpSync}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RemoteSyncDialogs({
  canSyncSkills,
  canSyncMcp,
  skillOpen,
  mcpOpen,
  onSkillOpenChange,
  onMcpOpenChange,
  localSkillSyncService,
  remoteSkillSyncService,
  localMcpSyncService,
  remoteMcpSyncService,
  remoteTarget,
  skillWorkspacePath,
  mcpWorkspacePath,
  mcpLocalWorkspacePath,
  workspaceIdentity,
  onSkillsSynced,
  onMcpSynced,
}: {
  canSyncSkills: boolean;
  canSyncMcp: boolean;
  skillOpen: boolean;
  mcpOpen: boolean;
  onSkillOpenChange: (open: boolean) => void;
  onMcpOpenChange: (open: boolean) => void;
  localSkillSyncService?: ISkillSyncService | null;
  remoteSkillSyncService?: ISkillSyncService | null;
  localMcpSyncService?: IMcpSyncService | null;
  remoteMcpSyncService?: IMcpSyncService | null;
  remoteTarget?: RemoteTarget | null;
  skillWorkspacePath: string;
  mcpWorkspacePath: string;
  mcpLocalWorkspacePath?: string;
  workspaceIdentity?: string;
  onSkillsSynced: () => Promise<void> | void;
  onMcpSynced: () => Promise<void> | void;
}) {
  const skillDialogProps =
    canSyncSkills && skillOpen && remoteTarget && localSkillSyncService && remoteSkillSyncService
      ? {
          localSkillSyncService,
          remoteSkillSyncService,
          remoteTarget,
        }
      : null;
  const mcpDialogProps =
    canSyncMcp && mcpOpen && remoteTarget && localMcpSyncService && remoteMcpSyncService
      ? {
          localMcpSyncService,
          remoteMcpSyncService,
          remoteTarget,
        }
      : null;

  return (
    <>
      {skillDialogProps ? (
        <RemoteSkillSyncDialog
          open={skillOpen}
          onOpenChange={onSkillOpenChange}
          localSkillSyncService={skillDialogProps.localSkillSyncService}
          remoteSkillSyncService={skillDialogProps.remoteSkillSyncService}
          remoteTarget={skillDialogProps.remoteTarget}
          workspacePath={skillWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          onSynced={onSkillsSynced}
        />
      ) : null}
      {mcpDialogProps ? (
        <RemoteMcpSyncDialog
          open={mcpOpen}
          onOpenChange={onMcpOpenChange}
          localMcpSyncService={mcpDialogProps.localMcpSyncService}
          remoteMcpSyncService={mcpDialogProps.remoteMcpSyncService}
          remoteTarget={mcpDialogProps.remoteTarget}
          workspacePath={mcpWorkspacePath}
          localWorkspacePath={mcpLocalWorkspacePath}
          onSynced={onMcpSynced}
        />
      ) : null}
    </>
  );
}
