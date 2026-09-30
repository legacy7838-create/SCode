import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
  TID_WORKFLOWS_REFRESH,
  resolveWorkspaceKey,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import {
  buildAutomationWorkspaceOptions,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import { AutomationRefreshIcon } from "@/settings/AutomationDesignPrimitives.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { buildSavedWorkflowCreatePrompt } from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import { SavedWorkflowProjectGroup } from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import { SavedWorkflowGlobalGroup } from "@/settings/saved-workflows/SavedWorkflowGlobalGroup.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import type {
  SavedWorkflowGroupState,
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

export type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
  SavedWorkflowLaunchTarget,
};

/**
 * Deep-link target: project by default (a missing scope is tolerated for legacy callers), or global
 * (no workspaceKey).
 */
export type SavedWorkflowsOpenTarget =
  | { scope?: "project"; workspaceKey: string; name: string }
  | { scope: "global"; name: string };

interface SavedWorkflowsSectionProps {
  /**
   * The page header (title switch + subtitle); rendered only in the list state — like the details
   * page and the scheduled-task editor, it takes over the whole page by itself.
   */
  header?: ReactNode;
  /**
   * The active workspace: used only to mark "Current" and as the creation target for the global
   * empty state.
   */
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** "Run" = launching directly from the GUI: once accepted, it switches to the new session. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  /**
   * "Create in chat"/"Revise in chat": only prefills the draft, it does not send; target = the
   * owning project (the empty-state card takes the active project).
   */
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  /**
   * "Open run" in the run history: switches to the session that started it and opens the instance
   * details page.
   */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** Artifact chip → `workflow-artifact` tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /**
   * A deep link lands directly on the details page; the caller clears it once located. project
   * needs a workspaceKey, global only needs a name.
   */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed?: () => void;
}

type SavedWorkflowsView =
  | { mode: "list" }
  | { mode: "detail"; scope: "project"; workspaceKey: string; name: string }
  | { mode: "detail"; scope: "global"; name: string };

/**
 * The global group's readiness uses the fixed key `"global"`, stored in the same table as the
 * project groups' workspaceKey.
 */
const GLOBAL_READINESS_KEY = "global";

function resolveOptionKey(option: AutomationWorkspaceOption): string {
  return resolveWorkspaceKey({
    workspacePath: option.workspacePath,
    ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
  });
}

/**
 * The saved-workflow hub: a fixed "Global" group at the top, with groups by opened project below
 * it. The page holds only the refresh counter, each group's loading state, and the details state;
 * the projects come from `buildAutomationWorkspaceOptions`.
 */
export function SavedWorkflowsSection({
  header,
  workspacePath,
  workspaceIdentity,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
}: SavedWorkflowsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const tabs = useTabStore((store) => store.tabs);
  const projects = useMemo(() => buildAutomationWorkspaceOptions(tabs), [tabs]);
  // The global group's run / move targets can only be local projects: filter out remote workspaces.
  const localProjects = useMemo(
    () => projects.filter((project) => !project.remoteSessionId),
    [projects],
  );

  const [view, setView] = useState<SavedWorkflowsView>({ mode: "list" });
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [readiness, setReadiness] = useState<Record<string, SavedWorkflowGroupState>>({});

  // Active workspace (passed in by the caller as a prop): gets the "current" badge, the global group's default target, and the create target of the global empty state.
  const activeKey = useMemo(
    () =>
      workspacePath
        ? resolveWorkspaceKey({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          })
        : null,
    [workspaceIdentity, workspacePath],
  );

  const handleStateChange = useCallback((key: string, next: SavedWorkflowGroupState) => {
    setReadiness((current) => {
      const prev = current[key];
      if (
        prev &&
        prev.loaded === next.loaded &&
        prev.empty === next.empty &&
        prev.count === next.count
      ) {
        return current;
      }
      return { ...current, [key]: next };
    });
  }, []);

  // After the global group "Move to Project..." moves a file, both groups have to re-pull it. The project team has no actions that will change the content of the two groups ("promote to global"
  // Just open a session, the global file is saved by the model, and appears naturally based on the directory monitoring of the global group), so only the global group calls it back.
  const handleMoved = useCallback(() => setRefreshSeq((seq) => seq + 1), []);

  // Deep link: drop openWorkflow to the corresponding details page, and then consume it. If the project is not among the candidates, it will only consume without jumping.
  const consumedRef = useRef<SavedWorkflowsOpenTarget | null>(null);
  useEffect(() => {
    if (!openWorkflow) {
      consumedRef.current = null;
      return;
    }
    if (consumedRef.current === openWorkflow) return;
    consumedRef.current = openWorkflow;
    if (openWorkflow.scope === "global") {
      setView({ mode: "detail", scope: "global", name: openWorkflow.name });
    } else if (
      projects.some((project) => resolveOptionKey(project) === openWorkflow.workspaceKey)
    ) {
      setView({
        mode: "detail",
        scope: "project",
        workspaceKey: openWorkflow.workspaceKey,
        name: openWorkflow.name,
      });
    }
    onOpenWorkflowConsumed?.();
  }, [onOpenWorkflowConsumed, openWorkflow, projects]);

  // The project is closed after the project details are opened: fall back to the list (use effect, not setState in rendering).
  useEffect(() => {
    if (
      view.mode === "detail" &&
      view.scope === "project" &&
      !projects.some((project) => resolveOptionKey(project) === view.workspaceKey)
    ) {
      setView({ mode: "list" });
    }
  }, [projects, view]);

  // Create target of the global empty card: the active project, or the first candidate when the active project is not among them (project-scoped creation).
  const emptyCardTarget = useMemo<SavedWorkflowProjectTarget | null>(() => {
    const active = projects.find((project) => resolveOptionKey(project) === activeKey);
    const target = active ?? projects[0];
    if (!target) return null;
    return {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
  }, [activeKey, projects]);

  const handleCreateFromEmpty = useCallback(() => {
    if (!emptyCardTarget) return;
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale), emptyCardTarget);
  }, [emptyCardTarget, locale, onCreateViaChat]);

  const globalGroupCommonProps = {
    refreshSeq,
    onStateChange: handleStateChange,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    localProjects,
    activeProjectKey: activeKey,
    onMoved: handleMoved,
  };

  // Detail state: render only the selected group (it renders the full-page detail itself), without the page header / toolbar row.
  if (view.mode === "detail" && view.scope === "global") {
    return (
      <SavedWorkflowGlobalGroup
        {...globalGroupCommonProps}
        mode={{ kind: "detail", name: view.name }}
        onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }
  if (view.mode === "detail") {
    const project = projects.find((candidate) => resolveOptionKey(candidate) === view.workspaceKey);
    if (project) {
      return (
        <SavedWorkflowProjectGroup
          key={view.workspaceKey}
          project={project}
          isCurrent={activeKey === view.workspaceKey}
          refreshSeq={refreshSeq}
          mode={{ kind: "detail", name: view.name }}
          onStateChange={handleStateChange}
          onOpenDetail={(name) =>
            setView({ mode: "detail", scope: "project", workspaceKey: view.workspaceKey, name })
          }
          onBack={() => setView({ mode: "list" })}
          onNavigateToLaunchedRun={onNavigateToLaunchedRun}
          onCreateViaChat={onCreateViaChat}
          onOpenWorkflowRun={onOpenWorkflowRun}
          onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        />
      );
    }
    // The project is closed after its detail page was opened: the effect above resets view to the list, so fall back to list rendering first.
  }

  const globalReady = readiness[GLOBAL_READINESS_KEY];
  const anyLoaded =
    Boolean(globalReady?.loaded) ||
    projects.some((project) => readiness[resolveOptionKey(project)]?.loaded);
  // The global empty status card only looks at project groups: it appears when all project groups are loaded and empty, and the empty/full status of the global group is ignored.
  const allProjectsLoaded =
    projects.length > 0 &&
    projects.every((project) => readiness[resolveOptionKey(project)]?.loaded);
  const allProjectsEmpty =
    allProjectsLoaded && projects.every((project) => readiness[resolveOptionKey(project)]?.empty);
  // The total number next to the title = the sum of the number of legal workflows for each loaded group (including global groups).
  const totalCount = projects.reduce(
    (sum, project) => {
      const entry = readiness[resolveOptionKey(project)];
      return sum + (entry?.loaded ? entry.count : 0);
    },
    globalReady?.loaded ? globalReady.count : 0,
  );

  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {header}

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.sectionTitle" })}
          {totalCount > 0 ? (
            <span className="ml-1 font-normal text-foreground-subtlest">{totalCount}</span>
          ) : null}
        </h2>
        <ControlHintTooltip title={intl.formatMessage({ id: "workflows.hub.refresh" })}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={intl.formatMessage({ id: "workflows.hub.refresh" })}
            data-testid={TID_WORKFLOWS_REFRESH}
            onClick={() => setRefreshSeq((seq) => seq + 1)}
          >
            <AutomationRefreshIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </ControlHintTooltip>
      </div>

      {!anyLoaded ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : null}

      {/*
         Groups stay mounted at all times so that each can load on its own and report its state (a
         not-ready / empty project group renders null internally; the global group shows even when
         empty); the first-paint spinner merely overlays on top and does not block loading. The
         global group is always pinned to the top, with the project groups below it.
         */}
      <div className={cn("flex flex-col", anyLoaded ? "mt-5" : "hidden")}>
        <SavedWorkflowGlobalGroup
          {...globalGroupCommonProps}
          mode={{ kind: "list" }}
          onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
          onBack={() => setView({ mode: "list" })}
        />

        {projects.length === 0 ? (
          <p className="mt-8 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "workflows.hub.noWorkspace" })}
          </p>
        ) : allProjectsEmpty ? (
          <div
            data-testid={TID_WORKFLOWS_EMPTY}
            className="mt-8 flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
          >
            <div className="flex translate-y-2 flex-col items-center gap-5">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.title" })}
                </p>
                <p className="max-w-[420px] text-ui-base leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.hint" })}
                </p>
              </div>
              <Button
                type="button"
                size="lg"
                data-icon="inline-start"
                data-testid={TID_WORKFLOWS_CREATE_VIA_CHAT}
                onClick={handleCreateFromEmpty}
              >
                <Plus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
              </Button>
            </div>
          </div>
        ) : null}

        {projects.map((project) => {
          const workspaceKey = resolveOptionKey(project);
          return (
            <SavedWorkflowProjectGroup
              key={workspaceKey}
              project={project}
              isCurrent={activeKey === workspaceKey}
              refreshSeq={refreshSeq}
              mode={{ kind: "list" }}
              onStateChange={handleStateChange}
              onOpenDetail={(name) =>
                setView({ mode: "detail", scope: "project", workspaceKey, name })
              }
              onBack={() => setView({ mode: "list" })}
              onNavigateToLaunchedRun={onNavigateToLaunchedRun}
              onCreateViaChat={onCreateViaChat}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onOpenWorkflowArtifact={onOpenWorkflowArtifact}
            />
          );
        })}
      </div>
    </div>
  );
}
