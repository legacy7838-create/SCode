import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";

/** The system group title is localized and displayed according to the locale, ignoring the fixed placeholder title ('cron' / 'off-peak') stored in the DB. */
function getTaskGroupDisplayTitle(
  group: { id: string; title: string },
  localizedSystemTitles: { cron: string; offPeak: string },
): string {
  if (group.id === CRON_DEFAULT_GROUP_ID) return localizedSystemTitles.cron;
  if (group.id === OFF_PEAK_DEFAULT_GROUP_ID) return localizedSystemTitles.offPeak;
  return group.title;
}

export { getTaskGroupDisplayTitle };
