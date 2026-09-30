/**
 * Only the default title auto-filled on the create page is synchronized.
 *
 * The default title used to read the locale only when the form was initialized, so after switching
 * languages the other copy had updated while the input kept the old language. User input, template
 * drafts, and saved task titles are all business data and must not be overwritten just because the
 * interface language changed.
 */
export function resolveLocalizedAutomationCreateTitle({
  currentTitle,
  hasInitialDraft,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialDraft: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialDraft || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}
