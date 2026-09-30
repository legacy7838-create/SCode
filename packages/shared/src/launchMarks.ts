/** The four launch instants captured by the main process (epoch milliseconds). The renderer uses them to compute per-stage timings. */
export interface LaunchMarks {
  /** process.getCreationTime(): process creation (anchor T0) */
  createdAt: number;
  /** Date.now() at the top of main/index.ts (T1) */
  mainStart: number;
  /** Date.now() at the app.whenReady callback entry (T2) */
  appReady: number;
  /** Date.now() before loadURL inside loadWindow of the main window (T3) */
  loadUrl: number;
}

/** Name of the parameter that carries the launch marks in the main window loadURL query string */
export const LAUNCH_MARKS_QUERY_KEY = "zcodeLaunchMarks";

export function serializeLaunchMarks(marks: LaunchMarks): string {
  return JSON.stringify(marks);
}

export function parseLaunchMarks(raw: string | null | undefined): LaunchMarks | null {
  if (raw == null || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys: (keyof LaunchMarks)[] = ["createdAt", "mainStart", "appReady", "loadUrl"];
  const result = {} as LaunchMarks;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    result[key] = value;
  }
  return result;
}
