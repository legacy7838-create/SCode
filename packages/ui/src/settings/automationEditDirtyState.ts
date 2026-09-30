export type AutomationEditDirtyField =
  | "title"
  | "prompt"
  | "schedule"
  | "mode"
  | "thoughtLevel"
  | "model";

export type AutomationEditFieldSignatures = Record<AutomationEditDirtyField, string>;

/**
 * Compares only the fields the user actually touched, so the system's normalization after form
 * initialization is not misread as an edit.
 */
export function resolveChangedAutomationEditFields(params: {
  touchedFields: ReadonlySet<AutomationEditDirtyField>;
  current: AutomationEditFieldSignatures;
  baseline: Partial<AutomationEditFieldSignatures>;
}): AutomationEditDirtyField[] {
  return [...params.touchedFields].filter(
    (field) =>
      params.baseline[field] !== undefined && params.current[field] !== params.baseline[field],
  );
}
