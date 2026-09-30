export function runContextPanelActionWithClose({
  action,
  close,
}: {
  action?: () => void;
  close: () => void;
}) {
  // Button clicks inside HoverCard will not automatically close the panel like external hover leave.
  // The entry action will switch to the settings page or usage details. The context panel must be closed first to avoid the old floating layer remaining.
  close();
  action?.();
}
