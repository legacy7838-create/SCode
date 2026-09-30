/**
 * The React bridge for the shortcut kernel: the only hook entry point for the effective table and
 * the display labels.
 *
 * The data source is useSettings' shared snapshot (setting.json), so once the settings page has
 * written → update → refresh, every consumer recomputes automatically; no separate store or
 * broadcast channel is introduced.
 */
import { useMemo } from "react";
import { type ShortcutCommandId } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveEffectiveShortcutBindings, type EffectiveShortcutBindings } from "./bindings.js";
import { formatShortcutBindingLabel } from "./label.js";

/**
 * The currently effective shortcut table (a read-only view after merging the defaults with the
 * user's overrides).
 */
export function useEffectiveShortcutBindings(): EffectiveShortcutBindings {
  const { settings } = useSettings();
  const overrides = settings?.shortcutBindings;
  return useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
}

/**
 * A command's display label: the first binding in the effective table, formatted. Unassigned
 * (overridden to an explicit empty array) returns an empty string and does not fall back to the
 * default display — the keys a tooltip advertises must match what is actually in effect, otherwise
 * a cleared command would still advertise the default keys while no longer responding to them (the
 * display-side extension of the empty-array semantics). The effective table is built over the full
 * set of commands, so only an illegal commandId can be missing a key, and that is treated the same
 * way.
 */
export function useShortcutCommandLabel(commandId: ShortcutCommandId): string {
  const effective = useEffectiveShortcutBindings();
  const first = effective[commandId]?.[0] ?? "";
  return first === "" ? "" : formatShortcutBindingLabel(first);
}
