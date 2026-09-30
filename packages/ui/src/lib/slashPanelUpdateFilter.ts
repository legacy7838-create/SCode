import { HISTORY_NAVIGATION_UPDATE_TAG } from "./editorUpdateTags.js";

/**
 * Decides whether SlashCommandPlugin's update listener should handle this editor update.
 *
 * Returns false for history navigation backfill, so that the panel — which registers arrow key
 * handlers at COMMAND_PRIORITY_CRITICAL — does not swallow the subsequent history paging
 * keypresses. Every other update (user input, other programmatic updates) returns true.
 */
export function shouldSlashPanelProcessUpdate(tags: ReadonlySet<string>): boolean {
  return !tags.has(HISTORY_NAVIGATION_UPDATE_TAG);
}
