// Status and actions of global workflow groups. Use hook to keep component files
// max-lines 400; the carrier is `useServices().zcodeAgentService`, and RPC always carries `{ scope: "global" }`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeSavedWorkflowEntry, ZCodeSavedWorkflowRun } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { useSavedWorkflowsDirectoryWatch } from "@/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.js";
import {
  buildSavedWorkflowCreatePrompt,
  buildSavedWorkflowRevisePrompt,
} from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import { lastRunByWorkflowName } from "@/settings/saved-workflows/savedWorkflowRunHistory.js";
import {
  GLOBAL_SAVED_WORKFLOW_TARGET,
  buildGlobalRunProjectResolver,
  findProjectByCwd,
  resolveGlobalActionTarget,
} from "@/settings/saved-workflows/globalWorkflowGroupHelpers.js";
import type { SavedWorkflowGroupMode } from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import { useSavedWorkflowRunOpeners } from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";
import type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";
import { selectSavedWorkflowState, useSavedWorkflowStore } from "@/store/savedWorkflowStore.js";

interface UseSavedWorkflowGlobalGroupParams {
  refreshSeq: number;
  mode: SavedWorkflowGroupMode;
  onStateChange: (key: "global", state: { loaded: boolean; empty: boolean; count: number }) => void;
  onOpenDetail: (name: string) => void;
  onBack: () => void;
  /** "Run" = GUI starts directly: switch to a new session after accepted. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** artifact chip → `workflow-artifact` tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  localProjects: readonly AutomationWorkspaceOption[];
  activeProjectKey: string | null;
  onMoved: () => void;
}

export function useSavedWorkflowGlobalGroup({
  refreshSeq,
  mode,
  onStateChange,
  onOpenDetail,
  onBack,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  localProjects,
  activeProjectKey,
  onMoved,
}: UseSavedWorkflowGlobalGroupParams) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const { zcodeAgentService: agentService, fileWatcherService } = useServices();

  const state = useSavedWorkflowStore((store) =>
    selectSavedWorkflowState(store, GLOBAL_SAVED_WORKFLOW_TARGET),
  );
  const load = useSavedWorkflowStore((store) => store.load);
  const [launchEntry, setLaunchEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [moveEntry, setMoveEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(
    async (options: { bypassCache?: boolean } = {}) => {
      await load(GLOBAL_SAVED_WORKFLOW_TARGET, agentService, options);
      setNow(Date.now());
    },
    [agentService, load],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lastRefreshSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastRefreshSeq.current === refreshSeq) return;
    lastRefreshSeq.current = refreshSeq;
    void refresh({ bypassCache: true });
  }, [refresh, refreshSeq]);

  // Directory monitoring: The absolute directory returned by the list (`~/.zcode/workflows`) can be watched directly on this machine.
  useSavedWorkflowsDirectoryWatch({
    fileWatcherService,
    directory: state.dir,
    enabled: true,
    refresh,
  });

  const empty = state.loaded && state.entries.length === 0 && state.invalid.length === 0;
  const count = state.loaded ? state.entries.length : 0;
  useEffect(() => {
    onStateChange("global", { loaded: state.loaded, empty, count });
  }, [count, empty, onStateChange, state.loaded]);

  const lastRuns = useMemo(() => lastRunByWorkflowName(state.runs), [state.runs]);
  const resolveRunProject = useMemo(
    () => buildGlobalRunProjectResolver(localProjects),
    [localProjects],
  );
  const actionTarget = useMemo(
    () => resolveGlobalActionTarget(localProjects, activeProjectKey),
    [activeProjectKey, localProjects],
  );

  // GUI direct launcher: Global file carrier = local base agent service, target = "Run on" selected local project.
  const launcher = useSavedWorkflowLauncher({
    agentService,
    onNavigate: onNavigateToLaunchedRun,
  });

  // Global files always pop up - even if there are no actual parameters, the "run on" selector is still required.
  const handleRun = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      launcher.clearError();
      setLaunchEntry(entry);
    },
    [launcher],
  );
  const launch = useCallback(
    async (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      target?: AutomationWorkspaceOption,
    ) => {
      if (!target) return;
      const result = await launcher.launch(
        {
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        },
        { name: entry.name, scope: "global", args },
      );
      // Success: the launcher has switched to a new session and closed the argument window; failure leaves the window + inline error (launcher.error).
      if (result.ok) setLaunchEntry(null);
    },
    [launcher],
  );
  const handleRevise = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      if (!actionTarget) return;
      onCreateViaChat?.(
        buildSavedWorkflowRevisePrompt({
          name: entry.name,
          path: entry.path,
          locale,
          scope: "global",
        }),
        actionTarget,
      );
    },
    [actionTarget, locale, onCreateViaChat],
  );
  const handleCreateViaChat = useCallback(() => {
    if (!actionTarget) return;
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale, "global"), actionTarget);
  }, [actionTarget, locale, onCreateViaChat]);
  const handleCopyPath = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      void navigator.clipboard
        ?.writeText(entry.path)
        .then(() => toast(intl.formatMessage({ id: "workflows.hub.copied" })))
        .catch((error: unknown) => {
          logger.warn("[SavedWorkflows] copy path failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [intl],
  );
  const handleDelete = useCallback(
    async (entry: ZCodeSavedWorkflowEntry) => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "workflows.hub.delete.title" }, { name: entry.name }),
        description: intl.formatMessage(
          { id: "workflows.hub.delete.description" },
          { path: entry.path },
        ),
        confirmLabel: intl.formatMessage({ id: "workflows.hub.delete.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyName(entry.name);
      try {
        const result = await agentService.deleteSavedWorkflow({
          scope: "global",
          name: entry.name,
        });
        if (!result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.deleteFailed" },
              { reason: intl.formatMessage({ id: `workflows.hub.reason.${result.reason}` }) },
            ),
          );
          return;
        }
        toast(intl.formatMessage({ id: "workflows.hub.deleted" }, { name: entry.name }));
        if (mode.kind === "detail" && mode.name === entry.name) onBack();
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.deleteFailed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
        void refresh({ bypassCache: true });
      }
    },
    [agentService, intl, mode, onBack, refresh, requestConfirmation],
  );
  const handleCardDelete = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => void handleDelete(entry),
    [handleDelete],
  );
  const handleCardMove = useCallback((entry: ZCodeSavedWorkflowEntry) => setMoveEntry(entry), []);
  const handleOpen = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => onOpenDetail(entry.name),
    [onOpenDetail],
  );
  // For the target project of the global file, press `run.cwd` to check the open project; if it is not open, both entries will be closed.
  // (The instance must be opened in the project that initiated it). The gate and argument structure is shared with the project file (the toolCallId is not required for the product).
  const resolveRunTarget = useCallback(
    (run: ZCodeSavedWorkflowRun) => findProjectByCwd(localProjects, run.cwd) ?? null,
    [localProjects],
  );
  const { handleOpenArtifact, handleOpenRun } = useSavedWorkflowRunOpeners({
    resolveTarget: resolveRunTarget,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
    ...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact }),
  });

  const handleMoveSubmit = useCallback(
    async (target: AutomationWorkspaceOption) => {
      const entry = moveEntry;
      if (!entry) return;
      setBusyName(entry.name);
      try {
        const result = await agentService.moveSavedWorkflow({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          name: entry.name,
        });
        if (result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.move.toast.project" },
              { project: target.label },
            ),
          );
          setMoveEntry(null);
          if (mode.kind === "detail" && mode.name === entry.name) onBack();
          onMoved();
          return;
        }
        toast(
          intl.formatMessage(
            {
              id:
                result.reason === "target_exists"
                  ? "workflows.hub.move.targetExists"
                  : "workflows.hub.move.failed",
            },
            { reason: result.reason },
          ),
        );
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.move.failed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
      }
    },
    [agentService, intl, mode, moveEntry, onBack, onMoved],
  );

  return {
    agentService,
    state,
    now,
    busyName,
    launchEntry,
    launchPending: launcher.pending,
    launchError: launcher.error,
    moveEntry,
    actionTarget,
    lastRuns,
    resolveRunProject,
    refresh,
    setLaunchEntry,
    setMoveEntry,
    handleRun,
    launch,
    handleRevise,
    handleCreateViaChat,
    handleCopyPath,
    handleDelete,
    handleCardDelete,
    handleCardMove,
    handleOpen,
    handleOpenRun,
    handleOpenArtifact,
    handleMoveSubmit,
  };
}
