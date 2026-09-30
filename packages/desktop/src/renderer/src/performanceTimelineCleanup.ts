const PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS = 10_000;

let cleanupTimer: ReturnType<typeof window.setInterval> | undefined;

export function startPerformanceTimelineCleanup(): void {
  if (!import.meta.env.DEV || cleanupTimer != null) {
    return;
  }

  // The development build of React 19.2 will write component rendering to the Performance timeline.
  // These PerformanceMeasures are strongly referenced by the window.performance native list, and will accumulate to the GB level during long-term development;
  // The scheduled cleanup here only affects the DevTools performance track and does not affect business logic and production packages.
  cleanupTimer = window.setInterval(() => {
    window.performance.clearMeasures();
    window.performance.clearMarks();
  }, PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
}
