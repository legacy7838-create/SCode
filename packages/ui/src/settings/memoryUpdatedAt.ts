import type { Locale } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

const MINUTE_MS = 60_000;
const RELATIVE_MINUTES_LIMIT = 30;

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatTime(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).format(timestamp);
}

function formatWeekday(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(timestamp);
}

function formatDate(timestamp: number, locale: Locale, includeYear: boolean): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(timestamp);
}

export function formatMemoryUpdatedAt({
  formatMessage,
  locale,
  now,
  updatedAt,
}: {
  formatMessage: IntlInstance["formatMessage"];
  locale: Locale;
  now: number;
  updatedAt: number;
}): string {
  const elapsedMs = now - updatedAt;
  if (!Number.isFinite(updatedAt) || elapsedMs < MINUTE_MS) {
    return formatMessage({ id: "settings.memory.viewer.updated.justNow" });
  }

  const elapsedMinutes = Math.floor(elapsedMs / MINUTE_MS);
  if (elapsedMinutes < RELATIVE_MINUTES_LIMIT) {
    return formatMessage(
      { id: "settings.memory.viewer.updated.minutesAgo" },
      { count: elapsedMinutes },
    );
  }

  const todayStart = startOfLocalDay(now);
  const updatedDayStart = startOfLocalDay(updatedAt);
  const time = formatTime(updatedAt, locale);
  if (updatedDayStart === todayStart) {
    return formatMessage({ id: "settings.memory.viewer.updated.today" }, { time });
  }

  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  if (updatedDayStart === yesterdayStart.getTime()) {
    return formatMessage({ id: "settings.memory.viewer.updated.yesterday" }, { time });
  }

  const today = new Date(todayStart);
  const weekStart = new Date(todayStart);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  if (updatedDayStart >= weekStart.getTime()) {
    return formatMessage(
      { id: "settings.memory.viewer.updated.weekday" },
      { time, weekday: formatWeekday(updatedAt, locale) },
    );
  }

  return formatMessage(
    { id: "settings.memory.viewer.updated.date" },
    {
      date: formatDate(
        updatedAt,
        locale,
        new Date(updatedAt).getFullYear() !== today.getFullYear(),
      ),
      time,
    },
  );
}
