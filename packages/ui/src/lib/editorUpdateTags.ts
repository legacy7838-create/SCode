/** The generic tag for programmatic updates (setText, setEditorStateJson, etc.) */
export const PROGRAMMATIC_UPDATE_TAG = "zcode-programmatic";

/**
 * The dedicated tag for history-navigation backfill. Previously PromptHistoryPlugin used the
 * generic PROGRAMMATIC_UPDATE_TAG when backfilling history entries, so SlashCommandPlugin's update
 * listener could not tell “the user is typing a slash query” apart from “history navigation wrote
 * an old entry containing / back into the editor”, and the panel would reopen, registering an
 * arrow-key handler at COMMAND_PRIORITY_CRITICAL that swallowed every subsequent ArrowUp/ArrowDown,
 * leaving the history index impossible to page through any further. With a dedicated tag,
 * SlashCommandPlugin can skip history-backfill updates precisely, leaving the panel's normal
 * behavior when the user types / by hand untouched.
 */
export const HISTORY_NAVIGATION_UPDATE_TAG = "zcode-history-navigation";
