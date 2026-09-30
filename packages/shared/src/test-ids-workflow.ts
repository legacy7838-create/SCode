// Test id related to dynamic workflow.
// test-ids.ts has reached the upper limit of oxlint max-lines (400 lines), and the entire workflow family has been removed;
// It is still exported from the @zcode/shared bucket file, and the consumer import path remains unchanged.

// GUI hub for saved workflows.
export const TID_AUTOMATIONS_PAGE_TAB = "automations-page-tab";
export const TID_WORKFLOWS_LIST = "workflows-list";
export const TID_WORKFLOWS_EMPTY = "workflows-empty";
export const TID_WORKFLOWS_REFRESH = "workflows-refresh";
export const TID_WORKFLOWS_CREATE_VIA_CHAT = "workflows-create-via-chat";
export const TID_WORKFLOW_PROJECT_GROUP = "workflow-project-group";
export const TID_WORKFLOW_GLOBAL_GROUP = "workflow-global-group";
export const TID_WORKFLOW_CARD = "workflow-card";
export const TID_WORKFLOW_CARD_RUN = "workflow-card-run";
export const TID_WORKFLOW_CARD_MENU = "workflow-card-menu";
export const TID_WORKFLOW_ACTION_DELETE = "workflow-action-delete";
export const TID_WORKFLOW_LAUNCH_DIALOG = "workflow-launch-dialog";
export const TID_WORKFLOW_LAUNCH_ARG = "workflow-launch-arg";
export const TID_WORKFLOW_LAUNCH_TARGET = "workflow-launch-target";
export const TID_WORKFLOW_LAUNCH_SUBMIT = "workflow-launch-submit";
// Direct start: error area in the actual parameter window. Growing out of the top of the session is a regular wheel end run card.
export const TID_WORKFLOW_LAUNCH_ERROR = "workflow-launch-error";
// Tail run card; suffix = `${turnKey}-${toolCallId}`.
export const TID_CHAT_WORKFLOW_RUN_DIGEST = "workflow-run-digest";
export const TID_WORKFLOW_ACTION_MOVE = "workflow-action-move";
export const TID_WORKFLOW_MOVE_DIALOG = "workflow-move-dialog";
export const TID_WORKFLOW_MOVE_DIALOG_TARGET = "workflow-move-dialog-target";
export const TID_WORKFLOW_MOVE_DIALOG_SUBMIT = "workflow-move-dialog-submit";
export const TID_WORKFLOW_DETAIL = "workflow-detail";
export const TID_WORKFLOW_DETAIL_RUN = "workflow-detail-run";
export const TID_WORKFLOW_DETAIL_MENU = "workflow-detail-menu";
export const TID_WORKFLOW_DETAIL_TAB = "workflow-detail-tab";
export const TID_WORKFLOW_DETAIL_DESCRIPTION = "workflow-detail-description";
export const TID_WORKFLOW_DETAIL_WHEN_TO_USE = "workflow-detail-when-to-use";
export const TID_WORKFLOW_DETAIL_SCRIPT = "workflow-detail-script";
export const TID_WORKFLOW_META_SAVE = "workflow-meta-save";
export const TID_WORKFLOW_META_DISCARD = "workflow-meta-discard";
export const TID_WORKFLOW_RUN_ROW = "workflow-run-row";

// The four appearances of user interface products.
//
// ⚠ Terminology: The artifact here is the output of the script that is published to the user via `artifact.*` (file / markdown /
// Kanban) is not the same name as the "script top-level return value" inside the engine `RunSettlement.artifact`.
//
// Only the four items of **entry level** are entered here (area, card, tab root, chip): they are the foothold of desktop e2e, write them down in each place.
// Literal values drift sooner or later. The version stepper, text kind, and head action inside the area are still literals in the component, and are the same as the run details page.
// The remaining partitions (`workflow-run-questions`, etc.) keep the same convention.
export const TID_WORKFLOW_ARTIFACTS_SECTION = "workflow-run-artifacts";
export const TID_WORKFLOW_ARTIFACTS_TOGGLE = "workflow-run-artifacts-toggle";
export const TID_WORKFLOW_ARTIFACT_CARD = "workflow-run-artifact-card";
/** Root node of the `workflow-artifact` side-panel tab. */
export const TID_WORKFLOW_ARTIFACT_PANE = "workflow-artifact-pane";
/** Chip on the hub (run history row / the detail page's "recent artifacts"). */
export const TID_WORKFLOW_ARTIFACT_CHIP = "workflow-run-artifact-chip";
/** Chip on the collapsed header of a terminal-state notification row in a session — deliberately a **different id** from the hub chip: the two draw their payloads from different
 *  sources, and e2e must be able to target "chips appeared on the notification row" and "chips appeared on the hub history row" separately. */
export const TID_CHAT_WORKFLOW_ARTIFACT_CHIP = "workflow-notification-artifact-chip";
