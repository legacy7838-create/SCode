import { useEffect, useState } from "react";

export function useRunningBackgroundTaskElapsedClock(runningTaskCount: number) {
  const [now, setNow] = useState(() => Date.now());
  const hasRunningTasks = runningTaskCount > 0;

  useEffect(() => {
    if (!hasRunningTasks) {
      return;
    }

    // A single task finishing must not restart the whole timer group, or the remaining tasks' seconds would briefly stall and then jump.
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [hasRunningTasks]);

  return now;
}
