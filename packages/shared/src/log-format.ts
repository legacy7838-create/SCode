/**
 * Log formatting utilities
 *
 * Provide uniform timestamp and log prefix formatting for every process (main/host/server/renderer).
 * Pure functions with no Node.js-specific API dependencies, safe in browser environments.
 */

/**
 * Formats a timestamp as "YYYY-MM-DD HH:mm:ss.mmm"
 */
export function formatTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}-${mo}-${d} ${h}:${min}:${s}.${ms}`;
}

/**
 * Builds a log prefix in a uniform format:
 * with PID: "[YYYY-MM-DD HH:mm:ss.mmm] [pid:12345] [source]"
 * without PID: "[YYYY-MM-DD HH:mm:ss.mmm] [source]"
 *
 * Node.js processes pass process.pid; the browser side omits it.
 */
export function formatLogPrefix(source: string, pid?: number): string {
  const ts = formatTimestamp();
  const pidPart = pid != null ? ` [pid:${pid}]` : "";
  return `[${ts}]${pidPart} [${source}]`;
}
