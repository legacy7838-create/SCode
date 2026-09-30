import { Plus } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_LIST,
  TID_WORKFLOW_GLOBAL_GROUP,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { SavedWorkflowCard } from "@/settings/saved-workflows/SavedWorkflowCard.js";
import { SavedWorkflowDetailView } from "@/settings/saved-workflows/SavedWorkflowDetailView.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import { SavedWorkflowMoveDialog } from "@/settings/saved-workflows/SavedWorkflowMoveDialog.js";
import { GLOBAL_SAVED_WORKFLOW_TARGET } from "@/settings/saved-workflows/globalWorkflowGroupHelpers.js";
import { useSavedWorkflowGlobalGroup } from "@/settings/saved-workflows/useSavedWorkflowGlobalGroup.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
} from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

interface SavedWorkflowGlobalGroupProps {
  /**
   * Page-level refresh counter; when it changes (other than on first mount), refetch bypassing the
   * cache.
   */
  refreshSeq: number;
  mode: SavedWorkflowGroupMode;
  onStateChange: (key: "global", state: SavedWorkflowGroupState) => void;
  onOpenDetail: (name: string) => void;
  onBack: () => void;
  /** "Run" = launching directly from the GUI: once accepted, switch to the new session. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** Artifact chip → the `workflow-artifact` tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /**
   * Local project candidates (remote `remoteSessionId` already filtered out): run target, amend
   * target, and the destination for "move to project".
   */
  localProjects: readonly AutomationWorkspaceOption[];
  /**
   * Active project key: the default "run on" of the input dialog, and the default target for amend
   * / create.
   */
  activeProjectKey: string | null;
  /** After a successful move, tells the page to refresh both groups. */
  onMoved: () => void;
}

/**
 * The global workflow group: the pinned "Global" group at the top, shown even when empty. Its
 * carrier does not use `useWorkspaceServicesResolution` — it uses `useServices().zcodeAgentService`
 * directly, RPCs carry `{ scope: "global" }`, and the services layer picks the local runtime
 * itself. Running goes through the input dialog carrying "Run on"; the card / detail view can "Move
 * to project…" to bring a workflow back to a local project. All state and actions live in
 * `useSavedWorkflowGlobalGroup`; this file only renders.
 */
export function SavedWorkflowGlobalGroup(props: SavedWorkflowGlobalGroupProps) {
  const {
    mode,
    onBack,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    localProjects,
    activeProjectKey,
  } = props;
  const { intl } = useZCodeIntl();
  const group = useSavedWorkflowGlobalGroup(props);
  const {
    agentService,
    state,
    now,
    busyName,
    launchEntry,
    launchPending,
    launchError,
    moveEntry,
    actionTarget,
    resolveRunProject,
    setLaunchEntry,
    setMoveEntry,
    launch,
    handleRun,
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
    lastRuns,
    refresh,
  } = group;

  const launchDialog = (
    <SavedWorkflowLaunchDialog
      entry={launchEntry}
      scope="global"
      projectLabel={intl.formatMessage({ id: "workflows.hub.global.title" })}
      targets={localProjects}
      defaultTargetKey={activeProjectKey}
      pending={launchPending}
      error={launchError}
      onOpenChange={(open) => (open ? undefined : setLaunchEntry(null))}
      onSubmit={(entry, args, target) => void launch(entry, args, target)}
    />
  );
  const moveDialog = (
    <SavedWorkflowMoveDialog
      open={moveEntry !== null}
      entryName={moveEntry?.name ?? null}
      targets={localProjects}
      defaultTargetKey={activeProjectKey}
      busy={busyName !== null}
      onOpenChange={(open) => (open ? undefined : setMoveEntry(null))}
      onSubmit={(target) => void handleMoveSubmit(target)}
    />
  );

  if (mode.kind === "detail") {
    const entry = state.entries.find((candidate) => candidate.name === mode.name);
    return (
      <>
        <SavedWorkflowDetailView
          target={GLOBAL_SAVED_WORKFLOW_TARGET}
          agentService={agentService}
          name={mode.name}
          projectLabel={intl.formatMessage({ id: "workflows.hub.global.title" })}
          entry={entry}
          runs={state.runs.filter((run) => run.name === mode.name)}
          now={now}
          busy={busyName === mode.name}
          canOpenRun={Boolean(onOpenWorkflowRun)}
          resolveRunProject={resolveRunProject}
          onBack={onBack}
          onRun={() => (entry ? handleRun(entry) : undefined)}
          onRevise={() => (entry ? handleRevise(entry) : undefined)}
          onCopyPath={() => (entry ? handleCopyPath(entry) : undefined)}
          onMove={() => (entry ? setMoveEntry(entry) : undefined)}
          onDelete={() => (entry ? void handleDelete(entry) : undefined)}
          onOpenRun={(run) => handleOpenRun(run, mode.name)}
          {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
          onMetaSaved={() => void refresh({ bypassCache: true })}
          launchDialog={launchDialog}
        />
        {moveDialog}
      </>
    );
  }

  const noActionTarget = actionTarget === null;
  const createButton = (
    <Button
      type="button"
      size="lg"
      data-icon="inline-start"
      data-testid={testId(TID_WORKFLOWS_CREATE_VIA_CHAT, "global")}
      disabled={noActionTarget}
      onClick={handleCreateViaChat}
    >
      <Plus className="size-4" aria-hidden="true" />
      {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
    </Button>
  );

  return (
    <div data-testid={TID_WORKFLOW_GLOBAL_GROUP} className="mt-8 first:mt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-ui-base font-medium leading-5 text-foreground">
          <span className="truncate">
            {intl.formatMessage({ id: "workflows.hub.global.title" })}
          </span>
          <span className="rounded-sm border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
            {intl.formatMessage({ id: "workflows.hub.global.hint" })}
          </span>
          {state.entries.length > 0 ? (
            <span className="font-normal text-foreground-subtlest">{state.entries.length}</span>
          ) : null}
        </h3>
        {noActionTarget ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "workflows.hub.launch.noLocalProject" })}
          >
            <span className="inline-flex">{createButton}</span>
          </ControlHintTooltip>
        ) : (
          createButton
        )}
      </div>

      {state.entries.length > 0 ? (
        <div
          data-testid={testId(TID_WORKFLOWS_LIST, "global")}
          className="mt-5 grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2"
        >
          {state.entries.map((entry) => (
            <SavedWorkflowCard
              key={entry.path}
              entry={entry}
              lastRun={lastRuns.get(entry.name)}
              now={now}
              busy={busyName === entry.name}
              onOpen={handleOpen}
              onRun={handleRun}
              onRevise={handleRevise}
              onCopyPath={handleCopyPath}
              onMove={handleCardMove}
              onDelete={handleCardDelete}
            />
          ))}
        </div>
      ) : state.errorCode === -32602 ? (
        <p className="mt-5 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "workflows.hub.global.unsupported" })}
        </p>
      ) : state.error ? (
        <p className="mt-5 text-ui-sm text-destructive">
          {intl.formatMessage({ id: "workflows.hub.global.noLocalRuntime" })} {state.error}
        </p>
      ) : (
        <p className="mt-5 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "workflows.hub.global.empty" })}
        </p>
      )}

      {state.invalid.length > 0 ? (
        <div
          data-workflows-invalid="true"
          className="mt-4 space-y-0.5 rounded-lg border border-warning/40 px-2.5 py-2"
        >
          <p className="text-ui-sm text-warning">
            {intl.formatMessage(
              {
                id:
                  state.invalid.length === 1 ? "workflows.hub.invalidOne" : "workflows.hub.invalid",
              },
              { count: String(state.invalid.length) },
            )}
          </p>
          {state.invalid.map((entry) => (
            <p
              key={entry.path}
              className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
              title={entry.reason}
            >
              {entry.path} — {entry.reason}
            </p>
          ))}
        </div>
      ) : null}

      {launchDialog}
      {moveDialog}
    </div>
  );
}
