/**
 * Automation only pins the outer size of the shared ConfirmDialog; the inner styles stay maintained
 * by the shared component.
 */
export const AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS =
  "min-h-[180px] w-[min(448px,calc(100vw-2rem))] max-w-none";

// Reason for merging: The remote end adds long copy protection, but it should not also cover the local confirmed internal visual style of the pop-up window.
export const AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS =
  "line-clamp-3 break-words whitespace-pre-line";
