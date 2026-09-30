// Playback export bucket.
//
// The downstream browser-side playback page must be assembled on the **static data** run details page: board (WorkflowRunGraphSection), read-only
// SessionPane, the header bar of the collapsed partition, and the Provider and data layers they require. These components are originally
// It is only used by the App within the package and is not exported from the index; a copy is released here without changing any component behavior.
//
// Discipline: Just re-export, don't define anything.
//
// Run Side Panel Results / Event Log /
// The three Script sections have been removed from the product, the corresponding three components have been deleted, and the entries here have also been removed. The event line is pure
// The formatter `workflowRunEventLines` is **retained** with its batch of i18n keys: it is not the piece of UI that was removed,
// It is the display rule of journal events, and browser-side playback still uses it on static data.
export { SessionPane, type SessionPaneProps } from "./v4/SessionPane.js";
export {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "./v4/V4ConversationContext.js";
export { SessionDataLayer, type SessionLease } from "./v4/sessionDataLayer.js";
export type { ConversationTransport, ConversationAttachmentReadParams } from "./v4/transport.js";
export { WorkflowRunPhaseList } from "./app-shell/WorkflowRunPhaseList.js";
export { WorkflowRunSectionToggle } from "./app-shell/WorkflowRunSectionToggle.js";
export {
  workflowRunEventLines,
  workflowRunResultView,
  type WorkflowActorInstance,
  type WorkflowRunEventItem,
  type WorkflowRunEventLine,
} from "./app-shell/workflowRunPanel.js";
export { WorkflowTimeline } from "./components/workflow-timeline/WorkflowTimeline.js";
export { buildWorkflowTimeline } from "./components/workflow-timeline/timeline-model.js";
export type { WorkflowCausalityGraphData } from "./components/workflow-graph/types.js";
export { workflowRunOverlay } from "./components/workflow-graph/run-status.js";
export { TooltipProvider } from "./components/ui/tooltip.js";
export { ServiceProvider } from "./hooks/useServices.js";
export { PlatformProvider } from "./hooks/usePlatform.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export { TabStoreProvider } from "./store/TabStoreProvider.js";
export { DiffsWorkerPoolProvider } from "./root/DiffsWorkerPoolProvider.js";
export { ZCodeIntlProvider, useZCodeIntl } from "./i18n/IntlProvider.js";
export { Button } from "./components/ui/button.js";
export { cn } from "./components/lib/utils.js";
