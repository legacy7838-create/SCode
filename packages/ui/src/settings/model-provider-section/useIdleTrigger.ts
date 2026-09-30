import { useCallback, useEffect, useRef, useState } from "react";

const MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS = 1_200;

/**
 * The “run after typing stops” scheduler shared by Provider text saving and Model Config
 * Resolution. New input only replaces the timer that has not fired yet; blur/Enter/save run the
 * same action immediately through flush.
 */
export function useIdleTrigger<TResult>(
  action: () => TResult | Promise<TResult>,
  delayMs = MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS,
) {
  const actionRef = useRef(action);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scheduled, setScheduled] = useState(false);
  actionRef.current = action;

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setScheduled(false);
  }, []);

  const flush = useCallback(async (): Promise<TResult> => {
    cancel();
    return actionRef.current();
  }, [cancel]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setScheduled(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setScheduled(false);
      // The failure of the Idle action is explicitly displayed by the corresponding form at the next blur/save; the timer itself cannot be created
      // unhandled rejection, otherwise a parsing failure will pollute the entire Renderer debugging link.
      try {
        void Promise.resolve(actionRef.current()).catch(() => undefined);
      } catch {
        // Synchronization failures also leave the corresponding form to be rendered when explicitly flushed.
      }
    }, delayMs);
  }, [delayMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return { cancel, flush, schedule, scheduled } as const;
}
