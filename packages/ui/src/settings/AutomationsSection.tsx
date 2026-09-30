import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- The main view of scheduled tasks centrally maintains lists, creates/edits full-page routes, and starts/stops/deletes operations. Centralization is more conducive to consistent interaction. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { CircleCheck, RotateCcw, TriangleAlert } from "lucide-react";
import {
  AUTOMATION_CREATE_LIMIT,
  BUILTIN_MODEL_PROVIDER_IDS,
  TID_AUTOMATION_ACTION_DELETE,
  TID_AUTOMATION_ACTION_TOGGLE,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CARD_MENU,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_STATUS_FILTER,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_TAB,
  isAutomationCreateLimitError,
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast as showToast, type ToastOptions } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { AutomationScheduledTemplateIcon } from "@/settings/AutomationScheduledTemplateIcon.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  OFF_PEAK_CREATE_TOOLTIP_CLASSNAME,
  formatOffPeakRemainingWait,
  resolveOffPeakCreateBlockReason,
  type OffPeakCreateBlockReason,
} from "@/settings/offPeakUiPresentation.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  useAutomationManagementStore,
  type AutomationRunNowResult,
} from "@/store/automationManagementStore.js";
import {
  isCurrentOffPeakCodingPlanSupported,
  resolveOffPeakCreateErrorMessageId,
  useOffPeakTaskStore,
  type OffPeakCreateDraft,
} from "@/store/offPeakTaskStore.js";
import {
  createAndReportOffPeakTask,
  freezeOffPeakCreateTelemetrySnapshot,
  reportOffPeakCreateResult,
} from "@/lib/offPeakTelemetry.js";
import { OffPeakTaskList } from "@/settings/OffPeakTaskList.js";
import { OffPeakTemplateIcon } from "@/settings/OffPeakTemplateIcon.js";
import { OffPeakEditView, type OffPeakEditSubmit } from "@/settings/OffPeakEditView.js";
import {
  formatAutomationCardNextRun,
  hasAutomationFailureState,
  resolveAutomationStatusKind,
  type AutomationStatusKind,
} from "@/settings/automationFormat.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";
import { AutomationEditView, type AutomationEditSubmit } from "@/settings/AutomationEditView.js";
import { AutomationScheduleBadge } from "@/settings/AutomationScheduleBadge.js";
import {
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationCreateDropdown,
  AutomationEditActionIcon,
  AutomationKeepAwakeNotice,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  AUTOMATION_STATUS_FILTERS,
  DEFAULT_AUTOMATION_STATUS_FILTER,
  filterAutomationsByStatus,
  filterOffPeakTasksByStatus,
  resolveAutomationTabState,
  type AutomationStatusFilter,
  type AutomationTabState,
} from "@/settings/automationStatusFilter.js";
import { isRemoteAutomationWorkspace } from "@/hooks/useAutomationProjectOptions.js";
import {
  reportAutomationActionClick,
  reportAutomationCreateResult,
  resolveAutomationSelectionTelemetry,
} from "@/lib/automationTelemetry.js";
import {
  materializeOffPeakTemplateDraft,
  materializeScheduledTemplateDraft,
  resolveOffPeakTemplateText,
  resolveAutomationTemplateText,
  type ScheduledAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import {
  AutomationsPageTitle,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import {
  readAutomationsPageTab,
  writeAutomationsPageTab,
} from "@/settings/saved-workflows/automationsPageTabMemory.js";
import {
  SavedWorkflowsSection,
  type SavedWorkflowLaunchTarget,
  type SavedWorkflowProjectTarget,
  type SavedWorkflowsOpenArtifactParams,
  type SavedWorkflowsOpenRunParams,
  type SavedWorkflowsOpenTarget,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationTemplateSkeletonGrid } from "@/settings/AutomationTemplateSkeletonGrid.js";

interface AutomationsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** "Create via chat": Switch to the session and let the agent create it using CronCreate; by default, it falls back to manually creating the entire page.
   * target = the project to which the workflow belongs; the "Create through dialogue" of the scheduled task does not have a target and falls into the active project. */
  onCreateViaChat?: (prompt: string, target?: SavedWorkflowProjectTarget) => void;
  /** Create the detailed navigation target of the card within the session; it will be cleared by the caller after successful positioning. */
  openAutomationId?: string | null;
  /** A one-time tab navigation target carried by the recommendation prompt word; only applied when the target tab is visible. "workflow" falls to the top-level "workflow" tag. */
  openAutomationTab?: AutomationsNavigationTab | null;
  onOpenAutomationConsumed?: () => void;
  /** Workflow "run" = GUI start directly: switch to a new session after accepted. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  /** Workflow running history "View Instance": Switch to the session that initiated it and open the instance details page. */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** artifact chip → `workflow-artifact` tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** The deep link falls directly to the details page; it is passed transparently to SavedWorkflowsSection and will be cleared by the caller after positioning. global only needs name. */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed?: () => void;
  /** Open the session associated with a certain run; the management page lists all projects and must carry the workspace to which the automation belongs. */
  onOpenSession?: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
}

export const AUTOMATIONS_TOAST_ANCHOR_ID = "automations-main-toast-anchor";

function toast(message: string, options?: ToastOptions): number {
  return showToast(message, {
    ...options,
    anchorId: AUTOMATIONS_TOAST_ANCHOR_ID,
  });
}

function OffPeakCreateButton({
  greyReason,
  greyTooltip,
  onCreate,
}: {
  greyReason: OffPeakCreateBlockReason | null;
  greyTooltip?: string;
  onCreate: () => void;
}) {
  const { intl } = useZCodeIntl();
  // disabled button pointer-events-none, tooltip must be hung on the outer pointer element.
  const button = (
    <Button
      type="button"
      variant="default"
      size="default"
      data-testid={TID_OFFPEAK_CREATE_BUTTON}
      disabled={greyReason !== null}
      onClick={onCreate}
    >
      {intl.formatMessage({ id: "offPeak.createButton" })}
    </Button>
  );

  if (!greyTooltip) return button;
  return (
    <ControlHintTooltip
      title={greyTooltip}
      side="top"
      align="center"
      className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}
    >
      <span className="inline-flex">{button}</span>
    </ControlHintTooltip>
  );
}

/** Create a pre-filled draft of the form (from the "More ideas" template). */
interface AutomationDraft {
  templateId?: string;
  title: string;
  cronExpr: string;
  prompt: string;
}

/** Main view internal routing: List / New / Edit. */
type AutomationsView =
  | { mode: "list" }
  | { mode: "create"; draft: AutomationDraft | null }
  | { mode: "edit"; automation: ZCodeAutomation }
  | { mode: "offpeak-create"; draft?: OffPeakCreateDraft }
  | { mode: "offpeak-edit"; task: ZCodeOffPeakTask };

/** Main view tab page: Scheduled is permanent, Idle-time is controlled by grayscale; there is no All mixed view. */
type AutomationsTab = "scheduled" | "idle";

const SCHEDULED_ONLY_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled"];
const SCHEDULED_AND_IDLE_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled", "idle"];

function resolveVisibleAutomationTabs({
  hasAnyTasks,
  offPeakVisible,
}: {
  hasAnyTasks: boolean;
  offPeakVisible: boolean;
}): readonly AutomationsTab[] {
  if (!hasAnyTasks) return [];
  return offPeakVisible ? SCHEDULED_AND_IDLE_AUTOMATION_TABS : SCHEDULED_ONLY_AUTOMATION_TABS;
}

function resolveAutomationTabAfterOffPeakChange(
  tab: AutomationsTab,
  offPeakVisible: boolean,
): AutomationsTab {
  return tab === "idle" && !offPeakVisible ? "scheduled" : tab;
}

function resolveAutomationTabNavigation({
  requestedTab,
  tabsReady,
  visibleTabs,
}: {
  requestedTab: AutomationsTab;
  tabsReady: boolean;
  visibleTabs: readonly AutomationsTab[];
}): { status: "pending" } | { status: "settled"; tab: AutomationsTab } {
  if (!tabsReady) return { status: "pending" };
  return {
    status: "settled",
    tab: visibleTabs.includes(requestedTab) ? requestedTab : "scheduled",
  };
}

function resolveAutomationTemplateVisibility({
  hasAnyTasks,
  offPeakCreationEnabled,
  tab,
}: {
  hasAnyTasks: boolean;
  offPeakCreationEnabled: boolean;
  tab: AutomationsTab;
}): {
  showOffPeakTemplates: boolean;
  showScheduledTemplates: boolean;
} {
  // After removing All tab, the empty home page still falls into Scheduled by default, causing idle templates to be accidentally hidden by tab conditions.
  // When there are no tasks, the two types of templates will be displayed side by side; when there are tasks, they will continue to be divided by the Scheduled / Idle tab.
  const showAllTemplates = !hasAnyTasks;
  return {
    showOffPeakTemplates: offPeakCreationEnabled && (showAllTemplates || tab === "idle"),
    showScheduledTemplates: showAllTemplates || tab === "scheduled",
  };
}

const STATUS_META: Record<
  AutomationStatusKind,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; className: string }
> = {
  active: { icon: AutomationClockIcon, className: "text-success" },
  // The pause state of the design draft is a stop-circle stroked icon and cannot be returned to a solid square within a circle.
  paused: { icon: AutomationPausedIcon, className: "text-foreground-subtle" },
  completed: { icon: CircleCheck, className: "text-foreground-subtle" },
  failed: { icon: TriangleAlert, className: "text-destructive" },
};

function automationPromptSummary(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : " ";
}

function canRestartAutomation(automation: Pick<ZCodeAutomation, "lifecycleStatus">): boolean {
  return automation.lifecycleStatus === "failed";
}

function canToggleAutomation(automation: Pick<ZCodeAutomation, "lifecycleStatus">): boolean {
  return automation.lifecycleStatus !== "completed" && automation.lifecycleStatus !== "failed";
}

function getAutomationRunNowToastId(
  result: AutomationRunNowResult,
): "automations.runNowQueued" | "automations.runNowAlreadyRunning" | "automations.runNowFailed" {
  if (result === "queued") return "automations.runNowQueued";
  if (result === "duplicate") return "automations.runNowAlreadyRunning";
  return "automations.runNowFailed";
}

type AutomationActionError = "create" | "update" | "toggle" | "restart" | "delete";

/** Raw Agent/RPC errors are left in the logger; the interface only displays understandable prompts corresponding to the current action. */
function getAutomationActionErrorToastId(action: AutomationActionError): string {
  return `automations.error.${action}`;
}

function getAutomationCreateErrorToastId(error: unknown): string {
  return isAutomationCreateLimitError(error)
    ? "automations.error.createLimit"
    : getAutomationActionErrorToastId("create");
}

function resolveAutomationDetailTarget(
  automations: readonly ZCodeAutomation[],
  automationId?: string | null,
): ZCodeAutomation | null {
  const targetId = automationId?.trim();
  if (!targetId) return null;
  return automations.find((automation) => automation.automationId === targetId) ?? null;
}

function resolveAutomationDetailNavigation(
  automations: readonly ZCodeAutomation[],
  automationId: string | null | undefined,
  listReady: boolean,
): { status: "pending" } | { status: "missing" } | { status: "found"; target: ZCodeAutomation } {
  if (!automationId?.trim() || !listReady) return { status: "pending" };
  const target = resolveAutomationDetailTarget(automations, automationId);
  return target ? { status: "found", target } : { status: "missing" };
}

/** Discrimination of `offpeak-` prefix id in openAutomationId (the unique generation point is: offpeak-${uuid} of offPeakTaskService). */
function isOffPeakDetailNavigationId(automationId: string | null | undefined): boolean {
  return Boolean(automationId?.trim().startsWith("offpeak-"));
}

/** Parallel parsing path for tail card jump during idle time; symmetrical with cron's resolveAutomationDetailNavigation. */
function resolveOffPeakDetailNavigation(
  tasks: readonly ZCodeOffPeakTask[],
  offPeakTaskId: string | null | undefined,
  listReady: boolean,
  listError: string | null = null,
):
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "missing" }
  | { status: "found"; target: ZCodeOffPeakTask } {
  const targetId = offPeakTaskId?.trim();
  if (!targetId || !listReady) return { status: "pending" };
  // review: store.refresh retains the old list if an error occurs; the found/missing final review cannot be performed when the list is not trustworthy.
  if (listError) return { status: "unavailable" };
  const target = tasks.find((task) => task.offPeakTaskId === targetId) ?? null;
  return target ? { status: "found", target } : { status: "missing" };
}

interface AutomationActionsMenuProps {
  automation: ZCodeAutomation;
  busy: boolean;
  canRestart: boolean;
  canToggle: boolean;
  onRunNow: (automation: ZCodeAutomation) => void;
  onEdit: (automation: ZCodeAutomation) => void;
  onToggle: (automation: ZCodeAutomation, enabled: boolean) => void;
  onRestart: (automation: ZCodeAutomation) => void;
  onDelete: (automation: ZCodeAutomation) => void;
}

function AutomationActionsMenu({
  automation,
  busy,
  canRestart,
  canToggle,
  onRunNow,
  onEdit,
  onToggle,
  onRestart,
  onDelete,
}: AutomationActionsMenuProps) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-hover md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-hover data-[state=open]:opacity-100"
          data-testid={TID_AUTOMATION_CARD_MENU}
          aria-label={intl.formatMessage({ id: "automations.moreActions" })}
          disabled={busy}
          // Cards can be clicked for editing; menu clicks will not bubble up to the card.
          onClick={(event) => event.stopPropagation()}
        >
          <AutomationMoreHorizontalIcon
            className="size-4 text-foreground-subtle"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-[190px]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Run immediately: Use busy to prevent duplication during the current RPC, and restore the entry after returning; active run is judged by host single-flight. */}
        <DropdownMenuItem
          className="gap-1"
          disabled={busy}
          onSelect={() => void onRunNow(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationRunNowIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.runNow" })}
        </DropdownMenuItem>
        {canRestart ? (
          <DropdownMenuItem
            className="gap-1"
            disabled={busy}
            onSelect={() => void onRestart(automation)}
          >
            <span className="flex size-5 items-center justify-center">
              <RotateCcw className="size-4" strokeWidth={1.33} aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "automations.restart" })}
          </DropdownMenuItem>
        ) : null}
        {/* The final task will not be displayed. pause/resume: failed can be restarted, completed can be completely closed and only view/delete will be retained. */}
        {canToggle ? (
          <DropdownMenuItem
            data-testid={TID_AUTOMATION_ACTION_TOGGLE}
            className="gap-1"
            disabled={busy}
            onSelect={() => void onToggle(automation, !automation.enabled)}
          >
            {automation.enabled ? (
              <span className="flex size-5 items-center justify-center">
                <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
              </span>
            ) : (
              <span className="flex size-5 items-center justify-center">
                <AutomationContinueIcon className="size-4" aria-hidden="true" />
              </span>
            )}
            {intl.formatMessage({
              id: automation.enabled ? "automations.pause" : "automations.resume",
            })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="gap-1"
          disabled={busy}
          onSelect={() => void onEdit(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationEditActionIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.form.editTitle" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={TID_AUTOMATION_ACTION_DELETE}
          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
          disabled={busy}
          onSelect={() => void onDelete(automation)}
        >
          <AutomationTrashIcon />
          {intl.formatMessage({ id: "automations.delete" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The placeholder when the status filter hits 0 items; reuse the stroke style of the idle status card, and distinguish the copy from "No tasks yet". */
function AutomationStatusFilterEmpty() {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "automations.statusFilter.empty" })}
    </div>
  );
}

export function AutomationsSection({
  workspacePath,
  workspaceIdentity,
  onCreateViaChat,
  openAutomationId,
  openAutomationTab,
  onOpenAutomationConsumed,
  onNavigateToLaunchedRun,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSession,
}: AutomationsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { clientScenesService, offPeakTaskService, zcodeAgentService } = useServices();
  const confirmDialog = useConfirmDialog();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const { status: entryStatus, label: entryLabel, retry: retryEntry } = useCodingPlanEntryGate();
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings();
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);

  const automations = useAutomationManagementStore((state) => state.automations);
  const automationCreateLimitReached = automations.length >= AUTOMATION_CREATE_LIMIT;
  const loading = useAutomationManagementStore((state) => state.loading);
  const operationId = useAutomationManagementStore((state) => state.operationId);
  const runsCache = useAutomationManagementStore((state) => state.runsCache);
  const initialize = useAutomationManagementStore((state) => state.initialize);
  const createAutomation = useAutomationManagementStore((state) => state.createAutomation);
  const updateAutomation = useAutomationManagementStore((state) => state.updateAutomation);
  const deleteAutomation = useAutomationManagementStore((state) => state.deleteAutomation);
  const setEnabled = useAutomationManagementStore((state) => state.setEnabled);
  const restartAutomation = useAutomationManagementStore((state) => state.restartAutomation);
  const runAutomationNow = useAutomationManagementStore((state) => state.runAutomationNow);
  const loadRuns = useAutomationManagementStore((state) => state.loadRuns);
  const deleteRun = useAutomationManagementStore((state) => state.deleteRun);
  const refresh = useAutomationManagementStore((state) => state.refresh);

  const automationTemplates = useAutomationTemplates(clientScenesService);
  const offPeakTasks = useOffPeakTaskStore((state) => state.tasks);
  const offPeakStoreLoading = useOffPeakTaskStore((state) => state.loading);
  const offPeakGrayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const offPeakCodingPlanSupport = useOffPeakTaskStore((state) => state.codingPlanSupport);
  const offPeakTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.takeNumberAvailability,
  );
  const offPeakTakeNumberAvailabilityStatus = useOffPeakTaskStore(
    (state) => state.takeNumberAvailabilityStatus,
  );
  const offPeakOperationId = useOffPeakTaskStore((state) => state.operationId);
  const offPeakRefresh = useOffPeakTaskStore((state) => state.refresh);
  const offPeakRefreshCodingPlanSupport = useOffPeakTaskStore(
    (state) => state.refreshCodingPlanSupport,
  );
  const offPeakRefreshTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.refreshTakeNumberAvailability,
  );
  const offPeakCreate = useOffPeakTaskStore((state) => state.createTask);
  const offPeakUpdate = useOffPeakTaskStore((state) => state.updateTask);
  const offPeakPause = useOffPeakTaskStore((state) => state.pauseTask);
  const offPeakContinue = useOffPeakTaskStore((state) => state.continueTask);
  const offPeakCancel = useOffPeakTaskStore((state) => state.cancelTask);
  const offPeakDelete = useOffPeakTaskStore((state) => state.deleteTask);
  const offPeakDeleteHistory = useOffPeakTaskStore((state) => state.deleteHistory);
  const consumePendingCreateDraft = useOffPeakTaskStore((state) => state.consumePendingCreateDraft);

  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<AutomationsView>({ mode: "list" });
  // tab and state filtering cohabitate the same state: all setTab calls are reduced by resolveAutomationTabState,
  // Once the tab changes to filter, it will return to all. Switching away and switching back will not restore the old filter.
  const [tabState, setTabState] = useState<AutomationTabState<AutomationsTab>>({
    tab: "scheduled",
    filter: DEFAULT_AUTOMATION_STATUS_FILTER,
  });
  const { tab, filter: statusFilter } = tabState;
  const setTab = useCallback(
    (next: AutomationsTab | ((current: AutomationsTab) => AutomationsTab)) =>
      setTabState((previous) =>
        resolveAutomationTabState(previous, typeof next === "function" ? next(previous.tab) : next),
      ),
    [],
  );
  const setStatusFilter = useCallback(
    (filter: AutomationStatusFilter) => setTabState((previous) => ({ ...previous, filter })),
    [],
  );
  // Dynamic workflow grayscale: If there is no hit, there will be no "workflow" label.
  // The page returns to a single "automation". When the snapshot is not ready, enabled is false. It is better to switch the title after half a shot than to flash first.
  // One tab and then collapsed—the hub is rarely the first thing users see when entering an app.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  // Top-level tab "Automation/Workflow": The page title is switched. The hub is now a cross-project view, and memory is no longer bucketed by project, using a single app-level key.
  const [storedPageTab, setPageTabState] = useState<AutomationsPageTab>(() =>
    readAutomationsPageTab(),
  );
  // When grayscale is turned off, the "workflow" memorized in sessionStorage is ignored: only the read value is narrowed, and the memory itself is unclear.
  // When grayscale is reopened, the user will still return to the last page. The hub is only mounted on the `pageTab === "workflow"` branch,
  // Narrowing pageTab equals SavedWorkflowsSection and never mounts it. There will be no frame of error mounting to send queries.
  const pageTab: AutomationsPageTab = dynamicWorkflowEnabled ? storedPageTab : "automation";
  const setPageTab = useCallback((next: AutomationsPageTab) => {
    setPageTabState(next);
    writeAutomationsPageTab(next);
  }, []);
  const activeWorkspaceTab = useTabStore((state) => {
    const activeTab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    return activeTab && isWorkspaceTab(activeTab) ? activeTab : undefined;
  });
  const currentWorkspaceIsRemote = isRemoteAutomationWorkspace(activeWorkspaceTab);
  // Grayscale flips midway: only the creation entrance is hidden; non-final state stocks are still displayed and run to the final state.
  const offPeakGrayEnabled = offPeakGrayConfig?.enabled === true;
  const offPeakCreationEnabled = offPeakGrayEnabled && !currentWorkspaceIsRemote;
  // Scanning all providers will treat the unselected Coding Plan as the current execution credentials.
  // Mock demo fields can still be overridden; real paths only accept masked resolver snapshots consistent with the current family/selectedKey.
  const offPeakNoPlan =
    offPeakGrayConfig?.codingPlanActive === false ||
    (offPeakGrayConfig?.codingPlanActive === undefined &&
      !offPeakStoreLoading &&
      !isCurrentOffPeakCodingPlanSupported(offPeakCodingPlanSupport, sharedSettings));
  const offPeakVisible =
    !currentWorkspaceIsRemote && (offPeakGrayEnabled || offPeakTasks.length > 0);
  const hasAnyTasks = automations.length > 0 || offPeakTasks.length > 0;
  const visibleTabs = resolveVisibleAutomationTabs({
    hasAnyTasks,
    offPeakVisible,
  });
  const hasVisibleTaskCards =
    tab === "scheduled" ? automations.length > 0 : offPeakTasks.length > 0;
  const visibleAutomations = filterAutomationsByStatus(automations, statusFilter);
  const visibleOffPeakTasks = filterOffPeakTasksByStatus(offPeakTasks, statusFilter);
  const { showOffPeakTemplates, showScheduledTemplates } = resolveAutomationTemplateVisibility({
    hasAnyTasks,
    offPeakCreationEnabled,
    tab,
  });
  const hasVisibleTemplates = showOffPeakTemplates || showScheduledTemplates;
  const showTaskTemplateSeparator = hasVisibleTaskCards && hasVisibleTemplates;
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // Relative time base; updated when refreshing the list to avoid frequent setInterval.
  const [now, setNow] = useState(() => Date.now());

  // Create admission fail-closed. Only if the server successfully returns canTakeNumber=true will it be released; if the qualifications are not met,
  // Loading/idle/error and quota false are both disabled to prevent dependency exceptions from being swallowed before errors are reported until they are actually created.
  const offPeakCreateGrey = useMemo(() => {
    const reason = resolveOffPeakCreateBlockReason({
      availabilityStatus: offPeakTakeNumberAvailabilityStatus,
      canTakeNumber: offPeakTakeNumberAvailability?.canTakeNumber,
      grayEnabled: offPeakGrayEnabled,
      noPlan: offPeakNoPlan,
    });
    const tooltip =
      reason === "plan"
        ? intl.formatMessage({ id: "offPeak.create.codingPlanOnly" })
        : reason === "unavailable"
          ? intl.formatMessage({ id: "offPeak.create.availabilityUnavailable" })
          : reason === "quota" && offPeakTakeNumberAvailability?.nextTakeAt !== undefined
            ? intl.formatMessage(
                { id: "offPeak.create.limitReachedAt" },
                {
                  time: formatOffPeakRemainingWait(
                    offPeakTakeNumberAvailability.nextTakeAt,
                    now,
                    intl,
                  ),
                },
              )
            : undefined;
    return { reason, tooltip };
  }, [
    intl,
    now,
    offPeakGrayEnabled,
    offPeakNoPlan,
    offPeakTakeNumberAvailability,
    offPeakTakeNumberAvailabilityStatus,
  ]);

  // The list is loaded according to the current project (the main view is passed into the current workspace by WorkspaceShellLayout).
  useEffect(() => {
    if (!workspacePath) return;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath,
      workspaceIdentity,
    });
    let disposed = false;
    setLoadedWorkspaceKey(null);
    setNow(Date.now());
    void initialize({
      workspacePath,
      workspaceIdentity,
      agentService: zcodeAgentService,
    }).then(() => {
      if (!disposed) setLoadedWorkspaceKey(workspaceKey);
    });
    return () => {
      disposed = true;
    };
  }, [workspacePath, workspaceIdentity, zcodeAgentService, initialize]);

  useEffect(() => {
    const nextTab = resolveAutomationTabAfterOffPeakChange(tab, offPeakVisible);
    if (nextTab === tab) return;
    // After the idle grayscale is turned off in the background, the Idle tab will be hidden; if the old status continues to be idle,
    // The scheduled task list will also be hidden by tab === "idle". Go back to Scheduled and ensure that the scheduled task is always accessible.
    setTab(nextTab);
  }, [offPeakVisible, tab]);

  useEffect(() => {
    if (!openAutomationTab) return;
    // Grayscale off: The requested "workflow" tag does not exist.
    // Fall to "automation" and consume the deep link - not consuming it will keep the request hanging and pull the page back repeatedly.
    if (openAutomationTab === "workflow" && !dynamicWorkflowEnabled) {
      setPageTab("automation");
      onOpenAutomationConsumed?.();
      return;
    }
    if (openAutomationTab === "workflow") {
      setPageTab("workflow");
      onOpenAutomationConsumed?.();
      return;
    }
    // The detailed navigation of idle time is unified by the offpeak branch below setTab("idle") + consumption; if you click here first
    // If the currently (possibly not yet loaded) visible tab returns to scheduled and consumed, the pending details navigation will be cleared as well.
    if (isOffPeakDetailNavigationId(openAutomationId)) return;
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    const result = resolveAutomationTabNavigation({
      requestedTab: openAutomationTab,
      tabsReady:
        currentWorkspaceKey !== null &&
        loadedWorkspaceKey === currentWorkspaceKey &&
        !offPeakStoreLoading,
      visibleTabs,
    });
    if (result.status === "pending") return;
    setPageTab("automation");
    if (result.tab !== tab) setTab(result.tab);
    onOpenAutomationConsumed?.();
  }, [
    dynamicWorkflowEnabled,
    loadedWorkspaceKey,
    offPeakStoreLoading,
    onOpenAutomationConsumed,
    openAutomationId,
    openAutomationTab,
    setPageTab,
    tab,
    visibleTabs,
    workspaceIdentity,
    workspacePath,
  ]);

  // The server gives an accurate recovery time; check again after the time is reached. The ban continues during refresh and after failure until true is returned successfully.
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    const delay = Math.max(0, nextTakeAt - Date.now()) + 100;
    const timer = setTimeout(() => {
      setNow(Date.now());
      void offPeakRefreshTakeNumberAvailability(offPeakTaskService);
    }, delay);
    return () => clearTimeout(timer);
  }, [offPeakRefreshTakeNumberAvailability, offPeakTaskService, offPeakTakeNumberAvailability]);

  // The quota tooltip has been changed to an absolute date that will not decrease; the minute boundary is advanced according to the remote implementation to keep the remaining time accurate.
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    const remainingMs = nextTakeAt - Date.now();
    if (remainingMs <= 0) return;
    const minuteMs = 60_000;
    const remainderMs = remainingMs % minuteMs;
    const delay = (remainderMs === 0 ? minuteMs : remainderMs) + 50;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, offPeakTakeNumberAvailability]);

  // Position/status polling refresh (host offPeakTaskSync writes to the library, renderer reads snapshots every 10s; no task rotation).
  useEffect(() => {
    if (view.mode !== "list" || offPeakTasks.length === 0) return;
    const timer = setInterval(() => {
      void offPeakRefresh(offPeakTaskService);
    }, 10_000);
    return () => clearInterval(timer);
  }, [view.mode, offPeakTasks.length, offPeakRefresh, offPeakTaskService]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refresh(zcodeAgentService),
        offPeakRefresh(offPeakTaskService),
        ...(offPeakGrayEnabled ? [offPeakRefreshCodingPlanSupport(offPeakTaskService)] : []),
      ]);
      setNow(Date.now());
    } finally {
      setRefreshing(false);
    }
  }, [
    offPeakGrayEnabled,
    offPeakRefresh,
    offPeakRefreshCodingPlanSupport,
    offPeakTaskService,
    refresh,
    zcodeAgentService,
  ]);

  // New task page template card jumps here: consume pre-filled draft → cut idle tab + open the create form pre-fill.
  useEffect(() => {
    const draft = consumePendingCreateDraft();
    if (!draft) return;
    if (currentWorkspaceIsRemote) return;
    setTab("idle");
    setView({ mode: "offpeak-create", draft });
  }, [consumePendingCreateDraft, currentWorkspaceIsRemote]);

  useEffect(() => {
    if (!currentWorkspaceIsRemote) return;
    setTab((current) => (current === "idle" ? "scheduled" : current));
    setView((current) =>
      current.mode === "offpeak-create" || current.mode === "offpeak-edit"
        ? { mode: "list" }
        : current,
    );
  }, [currentWorkspaceIsRemote]);

  const handleOpenCodingPlanUpgrade = useCallback(() => {
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const eventText = intl.formatMessage({
      id: "settings.modelProvider.codingPlan.upgrade",
    });
    // The reason for the missing point: Automations’ free time entrance previously bypassed the purchase funnel context and only opened the pop-up window.
    // Here, the entrance package status is frozen when the user clicks, and subsequent OAuth only refreshes the authentication and does not rebuild funnel.
    openCodingPlanUpgrade({
      providerId,
      initialAudience: "personal",
      funnelContext: createIdleTimeCodingPlanFunnelContext({
        providerId,
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView),
      }),
    });
  }, [intl, openCodingPlanUpgrade, providerSettingsView, sharedSettings?.providerFamilyDomain]);

  const showCodingPlanRequiredToast = useCallback(() => {
    toast(entryLabel ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel:
        entryStatus === "loading"
          ? undefined
          : (entryLabel ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      onAction: entryStatus === "error" ? retryEntry : handleOpenCodingPlanUpgrade,
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  }, [handleOpenCodingPlanUpgrade, intl, entryStatus, entryLabel, retryEntry]);

  const showAutomationCreateLimitToast = useCallback(() => {
    toast(
      intl.formatMessage(
        { id: "automations.error.createLimit" },
        { limit: String(AUTOMATION_CREATE_LIMIT) },
      ),
    );
  }, [intl]);

  // In-session OffPeakCreate is directly dropped into the library by the agent without going through the UI store; the initial loading value of the store is also
  // is false ("not loaded" is inseparable from "loaded"). Therefore each offpeak navigation forces a refresh of the list and ends with
  // "This navigation id refresh has been completed" is used as the only readiness signal to avoid misjudgment of targetNotFound with stale/empty lists.
  const [offPeakNavRefreshed, setOffPeakNavRefreshed] = useState<{
    id: string | null;
    error: string | null;
  }>({ id: null, error: null });
  useEffect(() => {
    if (!isOffPeakDetailNavigationId(openAutomationId)) return;
    let disposed = false;
    void offPeakRefresh(offPeakTaskService).finally(() => {
      if (disposed) return;
      // review: refresh does not reject, only writes store.error on failure; brings it out with the ready signal.
      setOffPeakNavRefreshed({
        id: openAutomationId ?? null,
        error: useOffPeakTaskStore.getState().error ?? null,
      });
    });
    return () => {
      disposed = true;
    };
  }, [openAutomationId, offPeakRefresh, offPeakTaskService]);

  useEffect(() => {
    // When idle, the tail card carries the offpeak- prefix id and is parsed from the parallel path into the offpeak-edit view;
    // It cannot fall into cron parsing (it will inevitably be missing and targetNotFound will be falsely reported).
    if (isOffPeakDetailNavigationId(openAutomationId)) {
      const result = resolveOffPeakDetailNavigation(
        offPeakTasks,
        openAutomationId,
        offPeakNavRefreshed.id === openAutomationId,
        offPeakNavRefreshed.error,
      );
      if (result.status === "pending") return;
      if (result.status === "found") {
        setTab("idle");
        setView({ mode: "offpeak-edit", task: result.target });
      } else if (result.status === "unavailable") {
        // Failed to refresh the list: fall to the idle tab and prompt loading failure, no false alarm of "task does not exist".
        setTab("idle");
        toast(intl.formatMessage({ id: "offPeak.nav.listUnavailable" }));
      } else {
        toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
      }
      onOpenAutomationConsumed?.();
      return;
    }
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    const result = resolveAutomationDetailNavigation(
      automations,
      openAutomationId,
      currentWorkspaceKey !== null && loadedWorkspaceKey === currentWorkspaceKey,
    );
    if (result.status === "pending") return;
    if (result.status === "found") {
      setView({ mode: "edit", automation: result.target });
    } else {
      // The target task may have been deleted; invalid one-time navigation must be prompted and consumed, and cannot affect subsequent entry to the page.
      toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
    }
    onOpenAutomationConsumed?.();
  }, [
    automations,
    intl,
    loadedWorkspaceKey,
    offPeakNavRefreshed,
    offPeakTasks,
    onOpenAutomationConsumed,
    openAutomationId,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleCreateManually = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    setView({ mode: "create", draft: null });
  }, [automationCreateLimitReached, showAutomationCreateLimitToast]);

  // "Create via chat": Leave it to parent and switch to the conversation view; if not provided, fall back to manually creating the entire page.
  const handleCreateViaChat = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    if (currentWorkspaceIsRemote) {
      // Automations creation can only be bound to local projects; the current remote session cannot be implicitly the creation target.
      // Still retain the admin page, but converge creation to a form with a local item selector.
      setView({ mode: "create", draft: null });
      return;
    }
    if (onCreateViaChat) {
      onCreateViaChat(intl.formatMessage({ id: "automations.createViaChat.prompt" }));
    } else setView({ mode: "create", draft: null });
  }, [
    automationCreateLimitReached,
    currentWorkspaceIsRemote,
    intl,
    onCreateViaChat,
    showAutomationCreateLimitToast,
  ]);

  const handleUseTemplate = useCallback(
    (template: ScheduledAutomationTemplate) => {
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return;
      }
      const draft = materializeScheduledTemplateDraft(template, locale);
      setView({
        mode: "create",
        draft,
      });
    },
    [automationCreateLimitReached, locale, showAutomationCreateLimitToast],
  );

  // Create/edit full page submission: Create a specifiable target project; edit and lock the original project.
  const handleEditSubmit = useCallback(
    async ({
      input,
      workspacePath: targetPath,
      workspaceIdentity: targetIdentity,
    }: AutomationEditSubmit) => {
      if (view.mode === "edit") {
        const ok = await updateAutomation(view.automation.automationId, input, zcodeAgentService);
        if (!ok) {
          toast(
            intl.formatMessage({
              id: getAutomationActionErrorToastId("update"),
            }),
          );
        } else {
          setNow(Date.now());
        }
        return ok;
      }
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return false;
      }
      const created = await createAutomation(
        {
          ...(input as Parameters<typeof createAutomation>[0]),
          workspacePath: targetPath,
          workspaceIdentity: targetIdentity,
        },
        zcodeAgentService,
      );
      void reportAutomationCreateResult(platform, {
        automationId: created?.automationId,
        cronExpr: input.cronExpr ?? "",
        templateId: view.mode === "create" ? view.draft?.templateId : undefined,
        error: useAutomationManagementStore.getState().error,
        modelFields: resolveAutomationSelectionTelemetry(
          input.modelSelection,
          providerSettingsView,
        ),
      });
      if (!created) {
        const createError = useAutomationManagementStore.getState().error;
        toast(
          intl.formatMessage(
            { id: getAutomationCreateErrorToastId(createError) },
            { limit: String(AUTOMATION_CREATE_LIMIT) },
          ),
        );
        return false;
      }
      setNow(Date.now());
      return true;
    },
    [
      automationCreateLimitReached,
      createAutomation,
      intl,
      platform,
      providerSettingsView,
      showAutomationCreateLimitToast,
      updateAutomation,
      view,
      zcodeAgentService,
    ],
  );

  const handleToggle = useCallback(
    async (automation: ZCodeAutomation, enabled: boolean) => {
      await setEnabled(automation.automationId, enabled, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("toggle") }));
      else {
        // The edit page view holds the automation object when entering the page; list refresh will not automatically replace it.
        // This partial object causes the copywriting to remain in the old state after clicking Pause/Resume on the menu.
        setView((prev) =>
          prev.mode === "edit" && prev.automation.automationId === automation.automationId
            ? {
                mode: "edit",
                automation: {
                  ...prev.automation,
                  enabled,
                  lifecycleStatus: enabled ? "active" : "paused",
                },
              }
            : prev,
        );
        setNow(Date.now());
      }
    },
    [intl, setEnabled, zcodeAgentService],
  );

  const handleRestart = useCallback(
    async (automation: ZCodeAutomation) => {
      await restartAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message)
        toast(
          intl.formatMessage({
            id: getAutomationActionErrorToastId("restart"),
          }),
        );
      else setNow(Date.now());
    },
    [intl, restartAutomation, zcodeAgentService],
  );

  const handleRunNow = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      logger.debug("[automations] run now interaction start", {
        automationId: automation.automationId,
        source,
      });
      void reportAutomationActionClick(platform, {
        action: "run_now",
        source,
        automation,
        providerSettingsView,
      });
      const result = await runAutomationNow(automation.automationId, zcodeAgentService);
      logger.debug("[automations] run now interaction end", {
        automationId: automation.automationId,
        source,
        result,
      });
      if (result === "queued") {
        await loadRuns(automation.automationId, zcodeAgentService, true);
        const latestSessionId = useAutomationManagementStore
          .getState()
          .runsCache[automation.automationId]?.runs?.find(
            (run) => run.trigger === "manual" && Boolean(run.sessionId),
          )?.sessionId;
        toast(
          intl.formatMessage({ id: "scheduledPreview.toast.running" }, { title: automation.title }),
          {
            durationMs: 4000,
            position: "top-center",
            variant: "info",
            ...(latestSessionId && onOpenSession
              ? {
                  actionLabel: intl.formatMessage({
                    id: "scheduledPreview.toast.view",
                  }),
                  onAction: () =>
                    onOpenSession({
                      sessionId: latestSessionId,
                      workspacePath: automation.workspacePath,
                      workspaceIdentity: automation.workspaceIdentity,
                    }),
                }
              : {}),
            dismissible: true,
            dismissLabel: intl.formatMessage({ id: "common.close" }),
          },
        );
        setNow(Date.now());
      } else if (result === "duplicate") {
        // Store/host will return duplicate when clicking continuously or when the previous manual run is still being executed.
        // Visible feedback must be given here, otherwise the user will think that the button is unresponsive.
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      } else if (result === "failed") {
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      }
    },
    [
      intl,
      loadRuns,
      onOpenSession,
      platform,
      providerSettingsView,
      runAutomationNow,
      zcodeAgentService,
    ],
  );

  const handleDelete = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      const confirmed = await confirmDialog({
        presentation: "automation-confirmation",
        title: intl.formatMessage({ id: "automations.delete.title" }),
        description: intl.formatMessage(
          { id: "automations.delete.description" },
          { title: automation.title },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
        confirmVariant: "destructive",
        // The sharing confirmation pop-up window renders esc / ⏎ on the right side of the button by default, and will be treated as an additional icon in the deleted scene.
        // The scheduled task delete button only retains the action text and does not change the keyboard prompt strategy of other confirmation pop-up windows.
        showKeyboardHints: false,
      });
      if (!confirmed) return;
      void reportAutomationActionClick(platform, {
        action: "delete",
        source,
        automation,
        providerSettingsView,
      });
      await deleteAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("delete") }));
      // If you are editing the entire page of the task, delete it and return to the list.
      setView((prev) =>
        prev.mode === "edit" && prev.automation.automationId === automation.automationId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, deleteAutomation, intl, platform, providerSettingsView, zcodeAgentService],
  );

  const handleOffPeakOpenSession = useCallback(
    (task: ZCodeOffPeakTask) => {
      if (!task.sessionId || !onOpenSession) return;
      onOpenSession({
        sessionId: task.sessionId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
    },
    [onOpenSession],
  );

  const handleOffPeakOpen = useCallback((task: ZCodeOffPeakTask) => {
    // The main click of the card with session cannot directly jump to the session: it will cause Settings/History
    // Unable to reach stably. Card primary paths always go into task details, sessions are only retained as explicit secondary actions.
    setView({ mode: "offpeak-edit", task });
  }, []);

  const handleOffPeakCancel = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "offPeak.cancel.title" }),
        description: intl.formatMessage(
          { id: "offPeak.cancel.description" },
          { title: task.title || task.prompt },
        ),
        confirmLabel: intl.formatMessage({ id: "offPeak.action.cancel" }),
      });
      if (!confirmed) return;
      await offPeakCancel(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [confirmDialog, intl, offPeakCancel, offPeakTaskService],
  );

  const handleOffPeakDelete = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "offPeak.delete.title" }),
        description: intl.formatMessage({ id: "offPeak.delete.description" }),
        confirmLabel: intl.formatMessage({ id: "offPeak.delete.confirm" }),
      });
      if (!confirmed) return;
      await offPeakDelete(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
      setView((prev) =>
        prev.mode === "offpeak-edit" && prev.task.offPeakTaskId === task.offPeakTaskId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, intl, offPeakDelete, offPeakTaskService],
  );

  const handleOffPeakDeleteHistory = useCallback(
    async (task: ZCodeOffPeakTask) => {
      await offPeakDeleteHistory(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [offPeakDeleteHistory, offPeakTaskService],
  );

  const handleOffPeakSubmit = useCallback(
    async (input: OffPeakEditSubmit) => {
      const current = view;
      const telemetrySnapshot =
        current.mode === "offpeak-create"
          ? freezeOffPeakCreateTelemetrySnapshot({
              source: current.draft?.telemetrySource,
              model: input.modelSelection.modelId,
              providerId: input.modelSelection.providerId,
            })
          : null;
      if (current.mode !== "offpeak-edit" && offPeakCreateGrey.reason !== null) {
        if (offPeakCreateGrey.reason === "plan") {
          showCodingPlanRequiredToast();
        } else if (offPeakCreateGrey.reason === "unavailable") {
          toast(intl.formatMessage({ id: "offPeak.error.unavailable" }));
        } else {
          toast(offPeakCreateGrey.tooltip ?? intl.formatMessage({ id: "offPeak.error.quota" }));
        }
        if (telemetrySnapshot) {
          void reportOffPeakCreateResult(platform, telemetrySnapshot, {
            ok: false,
            failureStage: "client_validation",
            errorCategory: "client_validation",
            errorCode: "",
            providerName: "",
          });
        }
        return false;
      }
      if (current.mode === "offpeak-edit") {
        const updated = await offPeakUpdate(
          current.task.offPeakTaskId,
          {
            title: input.title,
            prompt: input.prompt,
            permissionMode: input.permissionMode,
            modelSelection: input.modelSelection,
          },
          offPeakTaskService,
        );
        if (!updated) {
          toast(intl.formatMessage({ id: "offPeak.error.generic" }));
        }
        return updated;
      }

      const result =
        telemetrySnapshot !== null
          ? await createAndReportOffPeakTask(platform, telemetrySnapshot, () =>
              offPeakCreate(input, offPeakTaskService),
            )
          : await offPeakCreate(input, offPeakTaskService);
      if (!result.ok) {
        toast(
          intl.formatMessage({
            id: resolveOffPeakCreateErrorMessageId(result),
          }),
        );
      }
      return result.ok;
    },
    [
      intl,
      offPeakCreate,
      offPeakCreateGrey,
      offPeakTaskService,
      offPeakUpdate,
      platform,
      showCodingPlanRequiredToast,
      view,
    ],
  );

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "automations.noWorkspace" })}
      </div>
    );
  }

  // Free time tasks create/edit full page (form paradigm).
  if (view.mode === "offpeak-create" || view.mode === "offpeak-edit") {
    const editingTask =
      view.mode === "offpeak-edit"
        ? (offPeakTasks.find((task) => task.offPeakTaskId === view.task.offPeakTaskId) ?? view.task)
        : null;
    return (
      <>
        <OffPeakEditView
          editing={editingTask}
          initialDraft={view.mode === "offpeak-create" ? (view.draft ?? null) : null}
          modelSelectionView={
            offPeakGrayConfig?.modelSelectionView ?? { revision: 0, providers: [] }
          }
          defaultWorkspacePath={workspacePath ?? ""}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            offPeakOperationId?.startsWith("offpeak:create") ||
            offPeakOperationId?.startsWith("offpeak:update") ||
            false
          }
          createBlocked={view.mode === "offpeak-create" && offPeakCreateGrey.reason !== null}
          createBlockedTooltip={offPeakCreateGrey.tooltip}
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleOffPeakSubmit}
          onOpenSession={onOpenSession}
          onDelete={(task) => void handleOffPeakDelete(task)}
          onDeleteHistory={(task) => void handleOffPeakDeleteHistory(task)}
          onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
          onContinue={(task) => void offPeakContinue(task.offPeakTaskId, offPeakTaskService)}
          showToast={toast}
        />
      </>
    );
  }

  // Create/edit full page (with Settings/History tab).
  if (view.mode !== "list") {
    return (
      <>
        <AutomationEditView
          editing={view.mode === "edit" ? view.automation : null}
          initialDraft={view.mode === "create" ? view.draft : null}
          defaultWorkspacePath={workspacePath}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            operationId?.startsWith("automation:create") ||
            operationId?.startsWith("automation:update") ||
            false
          }
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleEditSubmit}
          onRunNow={(automation) => handleRunNow(automation, "editor")}
          onToggle={handleToggle}
          onDelete={(automation) => handleDelete(automation, "editor")}
          runsEntry={view.mode === "edit" ? runsCache[view.automation.automationId] : undefined}
          onLoadRuns={() => {
            if (view.mode === "edit")
              void loadRuns(view.automation.automationId, zcodeAgentService, true);
          }}
          onDeleteRun={(runId) => {
            if (view.mode === "edit") {
              void deleteRun(view.automation.automationId, runId, zcodeAgentService);
            }
          }}
          onOpenSession={
            view.mode === "edit" && onOpenSession
              ? (sessionId) => {
                  // The jump entry of the running history did not receive the navigation callback from the parent layer before, resulting in even if the run.sessionId
                  // Automation_runs has been written, and "Jump to session" will be hidden in the menu.
                  onOpenSession({
                    sessionId,
                    workspacePath: view.automation.workspacePath,
                    workspaceIdentity: view.automation.workspaceIdentity,
                  });
                }
              : undefined
          }
        />
      </>
    );
  }

  // The page title is the top-level switch: the two title words "Automation/Workflow"
  // Side by side, 30/34 follows the page title level of h1; the subtitle changes with the label.
  const pageHeader = (
    <div className="flex flex-col gap-3">
      <AutomationsPageTitle
        workflowTabEnabled={dynamicWorkflowEnabled}
        value={pageTab}
        onValueChange={setPageTab}
      />
      <p className="text-ui-base leading-5 text-foreground-subtlest">
        {intl.formatMessage({
          id:
            pageTab === "workflow"
              ? "workflows.hub.description"
              : hasAnyTasks
                ? "automations.description.populated"
                : "automations.description",
        })}
      </p>
    </div>
  );

  if (pageTab === "workflow") {
    return (
      <SavedWorkflowsSection
        header={pageHeader}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        onNavigateToLaunchedRun={onNavigateToLaunchedRun}
        onCreateViaChat={onCreateViaChat}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        openWorkflow={openWorkflow}
        onOpenWorkflowConsumed={onOpenWorkflowConsumed}
      />
    );
  }

  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {pageHeader}

      {/* Tab: Scheduled permanent; Idle only appears when grayscale hits or is idle, and All shuffled view is no longer provided.
         When there is a task, it is created in the upper right alignment (4866-1735); when the empty state is created, the entry is in the big card (4889-2013), and the top bar button is not repeated. */}
      {visibleTabs.length > 0 ? (
        <div className="mt-8 flex items-center justify-between">
          {/* The tab once shared the 12px spacing with the right operation group, which did not reflect the 8px compact rhythm required by the latest design. */}
          <div className="flex items-center gap-2" data-testid={TID_OFFPEAK_TAB}>
            {/* The unselected state does not force the surface background to be displayed in order to form a hierarchy with the hover and selected states. */}
            {visibleTabs.map((key) => (
              <button
                key={key}
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                  tab === key
                    ? "bg-selected text-foreground"
                    : "text-foreground-subtle hover:bg-hover hover:text-foreground",
                )}
                onClick={() => setTab(key)}
              >
                {intl.formatMessage({ id: `offPeak.tabs.${key}` })}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <ControlHintTooltip
              title={intl.formatMessage({
                id: refreshing ? "automations.refreshing" : "automations.refresh",
              })}
            >
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={intl.formatMessage({ id: "automations.refresh" })}
                onClick={() => void handleRefresh()}
                disabled={refreshing}
              >
                <AutomationRefreshIcon
                  className={cn("size-3.5", refreshing && "animate-spin")}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            {tab !== "idle" ? (
              <AutomationCreateDropdown
                onViaChat={handleCreateViaChat}
                onManually={handleCreateManually}
              />
            ) : null}
            {showOffPeakTemplates ? (
              <OffPeakCreateButton
                greyReason={offPeakCreateGrey.reason}
                greyTooltip={offPeakCreateGrey.tooltip}
                onCreate={() => setView({ mode: "offpeak-create" })}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Status filtering: scheduled/idle time share one group (all/in progress/completed/failed), which only appears when there are tasks in the current tab.
         The style follows the capsule of the top bar tab, but the font size and padding are smaller to reflect hierarchy. */}
      {visibleTabs.length > 0 && hasVisibleTaskCards ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-1.5"
          data-testid={TID_AUTOMATIONS_STATUS_FILTER}
        >
          {AUTOMATION_STATUS_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={statusFilter === key}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-ui-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                statusFilter === key
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover hover:text-foreground",
              )}
              onClick={() => setStatusFilter(key)}
            >
              {intl.formatMessage({ id: `automations.statusFilter.${key}` })}
            </button>
          ))}
        </div>
      ) : null}

      {loading && automations.length === 0 && offPeakTasks.length === 0 ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-8",
            // The old spacing between the list prompt bar and the action row is 16px, which is smaller than the 20px required by the design draft.
            hasAnyTasks ? "mt-5" : "mt-8",
          )}
        >
          <div className="flex w-full flex-col gap-4">
            {/* keep-awake is a global switch (mirroring the "General" setting page), and the scheduled task running session also benefits.
               Both tabs are displayed during scheduled/idle time. The list state is placed before the task card, and the empty state is kept before the big empty card. */}
            {hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}

            {/* After removing the All shuffle view, the two types of tasks no longer share the same grid; retain the anchor point to mark the starting point of the task area. */}
            <div data-automations-task-grid className="contents">
              {offPeakVisible && tab !== "scheduled" && offPeakTasks.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  {visibleOffPeakTasks.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <OffPeakTaskList
                      tasks={visibleOffPeakTasks}
                      busyOperationId={offPeakOperationId}
                      onOpen={handleOffPeakOpen}
                      onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
                      onContinue={(task) =>
                        void offPeakContinue(task.offPeakTaskId, offPeakTaskService)
                      }
                      onCancel={(task) => void handleOffPeakCancel(task)}
                      onDelete={(task) => void handleOffPeakDelete(task)}
                      onOpenSession={handleOffPeakOpenSession}
                    />
                  )}
                </section>
              ) : null}

              {/* Task created: Real scheduled tasks (all) that have been created by the current project. Click the entire card to edit.
                 The entire scheduled task area (card/empty state/created through dialogue) under the idle task tab is not rendered. */}
              {tab === "idle" ? null : automations.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                      {intl.formatMessage({ id: "automations.createdLabel" })}
                    </h2>
                    {/* When there is no tab row, the created entrance is placed on the right side of the title of this area; when there is a tab row, the entrance is already in the top bar to avoid duplication. */}
                    {visibleTabs.length === 0 ? (
                      <AutomationCreateDropdown
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                    ) : null}
                  </div>
                  {visibleAutomations.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <div
                      data-testid={TID_AUTOMATIONS_LIST}
                      className={cn(
                        "grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2",
                        // Design specifications expose up to 8 cards; the grid itself is responsible for scrolling. The threshold is calculated based on the filtered quantity.
                        // Otherwise, when a small number of cards are screened out, the height will still be locked and a large blank will be left.
                        visibleAutomations.length > 8 &&
                          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
                      )}
                    >
                      {visibleAutomations.map((automation) => {
                        const status = resolveAutomationStatusKind(automation);
                        const hasFailure = hasAutomationFailureState(automation);
                        const statusMeta = STATUS_META[status];
                        const StatusIcon = statusMeta.icon;
                        const scheduleText = describeAutomationCardSchedule(automation, intl);
                        const formattedNextRun = formatAutomationCardNextRun(
                          automation.nextRunAt,
                          now,
                          intl,
                        );
                        // Schedules in the completed/paused/failed state will no longer be advanced, but after a limited number of tasks have been run,
                        // nextRunAt may still point to a future moment and was spelled into the card to incorrectly read "next run". only active
                        // Only the cards that have not failed will have the next running time added, and the rest will only display the frequency summary.
                        const scheduleCardText =
                          status === "active" && !hasFailure && formattedNextRun
                            ? `${scheduleText} · ${intl.formatMessage(
                                { id: "automations.nextRun" },
                                { when: formattedNextRun },
                              )}`
                            : scheduleText;
                        // Card displays the cumulative number of scheduled + manual dispatches; maxRuns only constrains the scheduled plan.
                        // If used as the denominator, users will mistakenly think that "run immediately" also consumes limited task quota.
                        const runCountText = intl.formatMessage(
                          { id: "automations.runCount" },
                          { count: String(automation.runCount) },
                        );
                        const busy = operationId?.endsWith(`:${automation.automationId}`) ?? false;
                        // Completed means that the limited task has ended naturally and cannot be revived through Restart;
                        // failed is the recoverable final state, allowing the user to manually reschedule the next run.
                        const canRestart = canRestartAutomation(automation);
                        const canToggle = canToggleAutomation(automation);
                        return (
                          <div
                            key={automation.automationId}
                            data-testid={TID_AUTOMATION_CARD}
                            role="button"
                            tabIndex={0}
                            onClick={() => setView({ mode: "edit", automation })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setView({ mode: "edit", automation });
                              }
                            }}
                            className={cn(
                              // Task cards and template cards used to use surface/border respectively, and the stroke depth was inconsistent across themes.
                              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                              // Completed tasks remain statically weakened and do not restore transparency or change the background on hover.
                              status === "completed" ? "opacity-60" : "hover:bg-hover",
                            )}
                          >
                            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
                              <span className="block truncate pr-12 text-ui-base font-medium leading-5 text-foreground">
                                {automation.title}
                              </span>
                              <p className="text-wrap-phrase line-clamp-2 h-10 text-ui-base font-normal leading-5 text-foreground-subtle">
                                {automationPromptSummary(automation.prompt)}
                              </p>
                              <div className="mt-auto flex h-6 min-w-0 items-center gap-2 text-ui-base leading-5">
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  {hasFailure ? (
                                    <>
                                      <span className="inline-flex shrink-0 items-center py-0.5 pl-1 pr-2 font-normal text-destructive">
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <TriangleAlert
                                            className="size-4"
                                            strokeWidth={1.33}
                                            aria-hidden="true"
                                          />
                                        </span>
                                        <span className="pl-1">
                                          {intl.formatMessage({
                                            id: "automations.lifecycle.failed",
                                          })}
                                        </span>
                                      </span>
                                      {/* Only the cron summary is displayed in the failure state, and it is forbidden to mistakenly write the expired nextRunAt as "next run". */}
                                      <span className="inline-flex min-w-0 items-center rounded-md bg-success/10 py-0.5 pl-1 pr-2 font-normal text-success opacity-40">
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <AutomationClockIcon
                                            className="size-4"
                                            aria-hidden="true"
                                          />
                                        </span>
                                        <span className="truncate pl-1">{scheduleCardText}</span>
                                      </span>
                                    </>
                                  ) : status === "active" ? (
                                    <AutomationScheduleBadge
                                      text={scheduleCardText}
                                      icon={
                                        <StatusIcon
                                          className="size-4 shrink-0"
                                          strokeWidth={1.33}
                                          aria-hidden="true"
                                        />
                                      }
                                    />
                                  ) : (
                                    <>
                                      <span
                                        className={cn(
                                          "inline-flex shrink-0 items-center gap-1 font-normal",
                                          statusMeta.className,
                                        )}
                                      >
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <StatusIcon
                                            className="size-4 shrink-0"
                                            strokeWidth={1.33}
                                            aria-hidden="true"
                                          />
                                        </span>
                                        {intl.formatMessage({
                                          id: `automations.lifecycle.${status}`,
                                        })}
                                      </span>
                                      {status === "paused" || status === "completed" ? (
                                        /* After the pause/completion, the schedule will no longer advance, only the cron summary will be displayed, and nextRunAt will not be displayed. */
                                        <AutomationScheduleBadge
                                          dimmed
                                          text={scheduleCardText}
                                          icon={
                                            <AutomationClockIcon
                                              className="size-4"
                                              aria-hidden="true"
                                            />
                                          }
                                        />
                                      ) : null}
                                    </>
                                  )}
                                </div>
                                <span
                                  className={cn(
                                    "inline-flex shrink-0 items-center whitespace-nowrap rounded-md bg-surface px-1.5 py-0.5 text-ui-base font-normal text-foreground-subtle",
                                    (hasFailure || status === "paused") && "opacity-40",
                                  )}
                                >
                                  {runCountText}
                                </span>
                              </div>
                            </div>

                            <div className="absolute right-3 top-3 flex items-center gap-1">
                              {busy ? <Spinner className="size-3.5" /> : null}
                              <AutomationActionsMenu
                                automation={automation}
                                busy={busy}
                                canRestart={canRestart}
                                canToggle={canToggle}
                                onRunNow={handleRunNow}
                                onEdit={(target) => setView({ mode: "edit", automation: target })}
                                onToggle={handleToggle}
                                onRestart={handleRestart}
                                onDelete={handleDelete}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              ) : (
                /* The empty state card precedes Keep-awake, and the entire button group is moved 8px lower than the center of the card. */
                <div
                  data-automations-empty-state
                  className="flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
                >
                  <div className="flex translate-y-2 flex-col items-center gap-5">
                    <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                      {intl.formatMessage({ id: "automations.empty.title" })}
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <AutomationCreateDropdown
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                      {/* When you have free time tasks, an entrance has been created in the upper right corner, and empty cards will no longer be repeated (4866-1735 vs 4889-2013). */}
                      {offPeakCreationEnabled && offPeakTasks.length === 0 ? (
                        <OffPeakCreateButton
                          greyReason={offPeakCreateGrey.reason}
                          greyTooltip={offPeakCreateGrey.tooltip}
                          onCreate={() => setView({ mode: "offpeak-create" })}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* The empty status wake-up prompt bar is located behind the big empty card. */}
            {!hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}
          </div>

          {/* Real task cards and templates cannot rely solely on blank partitions: dividing lines are required;
             The dividing line using surface is too light under Light, so card-border is used uniformly with Card.
             Add this container py-2 to the outer gap-8, so that the card to the line and the line to the template title remain 40px. */}
          {showTaskTemplateSeparator ? (
            <div
              data-automations-task-template-separator
              className="flex w-full flex-col py-2"
              aria-hidden="true"
            >
              <div className="h-px w-full bg-card-border" />
            </div>
          ) : null}

          {/* Idle-time task template (grayscale hit; same source copy as New task page). */}
          {showOffPeakTemplates ? (
            <section
              data-automations-idle-templates
              aria-busy={automationTemplates.loading}
              className="flex w-full flex-col gap-4"
            >
              <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "offPeak.templates.sectionTitle" })}
              </h2>
              {automationTemplates.loading ? (
                <AutomationTemplateSkeletonGrid
                  label={intl.formatMessage({ id: "common.loading" })}
                />
              ) : automationTemplates.offPeak.length === 0 ? (
                <div
                  data-automation-template-empty-state
                  className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
                >
                  {intl.formatMessage({ id: "automations.templates.unavailable" })}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  {automationTemplates.offPeak.map((template) => {
                    const planLocked = offPeakCreateGrey.reason === "plan";
                    const card = (
                      <button
                        type="button"
                        onClick={() => {
                          if (planLocked) {
                            showCodingPlanRequiredToast();
                            return;
                          }
                          const materializedDraft = materializeOffPeakTemplateDraft(
                            template,
                            locale,
                          );
                          setView({
                            mode: "offpeak-create",
                            draft: template.customize
                              ? {
                                  telemetrySource: {
                                    eventRegion: "app.automations",
                                    templateId: template.id,
                                  },
                                }
                              : {
                                  title: materializedDraft.title,
                                  prompt: materializedDraft.prompt,
                                  telemetrySource: {
                                    eventRegion: "app.automations",
                                    templateId: template.id,
                                  },
                                },
                          });
                        }}
                        // Although the Grid wrapper has been stretched to the row height, the card body still needs to be h-full to inherit the maximum height of the same row; when only min-height is set, the short copy card will be shorter.
                        className="flex h-full min-h-[114px] w-full flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      >
                        <div className="flex items-center gap-0.5 text-foreground">
                          <OffPeakTemplateIcon
                            className="size-4 shrink-0"
                            iconName={template.iconName}
                            name={template.icon}
                          />
                          <span className="truncate px-1 text-ui-base font-medium leading-5 text-foreground">
                            {resolveOffPeakTemplateText(
                              template,
                              "title",
                              locale,
                              intl.formatMessage,
                            )}
                          </span>
                        </div>
                        <p className="text-wrap-phrase line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                          {resolveOffPeakTemplateText(
                            template,
                            "description",
                            locale,
                            intl.formatMessage,
                          )}
                        </p>
                        <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                          {intl.formatMessage({
                            id: "offPeak.form.soonestAvailable",
                          })}
                        </div>
                      </button>
                    );
                    return (
                      <div key={template.id} className="h-full">
                        {card}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {/* Scheduled task template: Client Scenes candidate directory; click to prefill only to create a new full page. The idle task tab is not displayed. */}
          {showScheduledTemplates ? (
            <section
              data-automations-scheduled-templates
              aria-busy={automationTemplates.loading}
              className="flex w-full flex-col gap-4"
            >
              <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "automations.moreIdeas" })}
              </h2>
              {automationTemplates.loading ? (
                <AutomationTemplateSkeletonGrid
                  label={intl.formatMessage({ id: "common.loading" })}
                />
              ) : automationTemplates.scheduled.length === 0 ? (
                <div
                  data-automation-template-empty-state
                  className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
                >
                  {intl.formatMessage({ id: "automations.templates.unavailable" })}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {automationTemplates.scheduled.map((template) => {
                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => handleUseTemplate(template)}
                        className="group flex min-h-[114px] flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      >
                        <div className="flex min-w-0 items-center gap-1 text-foreground">
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <AutomationScheduledTemplateIcon
                              iconName={template.iconName}
                              name={template.icon}
                            />
                          </span>
                          <span className="truncate text-ui-base font-medium leading-5 text-foreground">
                            {resolveAutomationTemplateText(template.title, locale)}
                          </span>
                        </div>
                        {/* When the scheduled template was first implemented, the cycle time was spelled into the title row, which was inconsistent with the bottom time level of the idle template. */}
                        <p className="line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                          {resolveAutomationTemplateText(template.description, locale)}
                        </p>
                        <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                          {describeAutomationCardSchedule({ cronExpr: template.cronExpr }, intl)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
