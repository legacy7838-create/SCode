import { useEffect, useRef, useState } from "react";

/**
 * The pen that writes the draft.
 *
 * The model's script arrives in chunks, so what the scanner sees is a jump: a whole
 * `phase("implement")` inside one delta, sometimes two phases arriving together. The pen turns the
 * jump back into writing: one station at a time, `PEN_MS` per character, and after finishing a
 * station it pauses for `PEN_GAP_MS` before revealing the next one — stations the pen has not
 * reached are not on track yet, even when the scanner already knows about them. When a name grows
 * mid-write (more characters arrive for an unterminated `phase("ver`) the pen keeps writing; when a
 * name shrinks or its prefix changes (which should not happen, but streaming has to stay stable)
 * the pen falls back to the common prefix.
 *
 * `names` is the scanner's current sequence of station names; undefined means this is not a draft
 * and the hook stays silent. Timing keys off **content** changes only (keyed by content), so a
 * fresh array for every chunk of script does not interrupt the pen that is already moving. Under
 * `prefers-reduced-motion: reduce` a whole station is written at once (still revealed station by
 * station, just not character by character).
 *
 * Revision (the root cause of the GUI crashing with React #185): the pen only reveals when **there
 * is a station to reveal**. If "reveal immediately when there are no stations yet" ignores the
 * station count, an empty draft (the `meta` at the start of the script has not reached its first
 * `phase(`) reveals a station that does not exist, gets trimmed back to 0 on the next round,
 * reveals again… and spins setState forever inside an effect. That spinning only burns CPU by
 * itself, but it keeps a pending update permanently in React's hands; once projected frames pile up
 * into dozens of consecutive synchronous commits, the nested update count passes 50, React throws
 * #185, and the whole chat area is taken over by the error boundary.
 */
export const PEN_MS = 24;
export const PEN_GAP_MS = 120;

export interface TypewriterState {
  /**
   * The number of stations revealed so far (the ones the pen has reached); later stations are not
   * on track yet.
   */
  visible: number;
  /** The number of characters already written for each revealed station. */
  shown: readonly number[];
  /**
   * The pen has caught up with the stream (no character left to write, no station left to reveal):
   * the cursor blinks.
   */
  idle: boolean;
}

interface PenState {
  visible: number;
  shown: number[];
}

const SILENT: TypewriterState = { idle: false, shown: [], visible: 0 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * When a station name changes (it shrinks / its prefix changes / there are fewer stations), move
 * the pen back to the still-valid position; when nothing changed, return it unchanged.
 */
function reconcile(
  state: PenState,
  names: readonly string[],
  previous: readonly string[],
): PenState {
  const visible = Math.min(state.visible, names.length);
  let changed = visible !== state.visible;
  const shown = state.shown.slice(0, visible).map((count, i) => {
    const next = Math.min(count, commonPrefix(previous[i] ?? "", names[i]!));
    if (next !== count) changed = true;
    return next;
  });
  return changed ? { shown, visible } : state;
}

/**
 * The number of characters written for each revealed station. Under reduced motion a whole station
 * counts as written, **derived at render time** instead of another setState round inside an effect:
 * station names grow with every delta, so the setState in the effect lands exactly inside a
 * projected frame's synchronous commit, charging the nested update count on every frame.
 */
function shownOf(state: PenState, names: readonly string[], reduced: boolean): readonly number[] {
  return reduced ? state.shown.map((_, i) => names[i]?.length ?? 0) : state.shown;
}

export function useTypewriter(names: readonly string[] | undefined): TypewriterState {
  const [state, setState] = useState<PenState>({ shown: [], visible: 0 });
  // The delimiter is NUL (which will not appear in the station name), so that ["a b"] and ["a", "b"] will not collide with the same key. You cannot write one directly in the source code
  // For bare NUL bytes, git treats the entire file as binary; change it to escaped writing, and the content remains unchanged.
  const key = names?.join("\u0000");
  const namesRef = useRef<readonly string[]>([]);
  const lastRef = useRef<readonly string[]>([]);
  if (names !== undefined) namesRef.current = names;

  useEffect(() => {
    if (key === undefined) return undefined;
    const current = namesRef.current;
    const previous = lastRef.current;
    lastRef.current = current;
    const pen = reconcile(state, current, previous);
    if (pen !== state) {
      setState(pen);
      return undefined;
    }
    const reduced = prefersReducedMotion();
    const at = pen.visible - 1;
    const target = at >= 0 ? current[at]! : undefined;
    const written = target === undefined ? 0 : (shownOf(pen, current, reduced)[at] ?? 0);
    if (target !== undefined && written < target.length) {
      // Write the current site word for word (written under reduced-motion is already the entire site, so you won’t go here).
      const timer = setTimeout(() => {
        const shown = pen.shown.slice();
        shown[at] = written + 1;
        setState({ shown, visible: pen.visible });
      }, PEN_MS);
      return () => clearTimeout(timer);
    }
    // The current station has been written (or there is no station yet): **Not revealed until the next station** - An empty draft does nothing.
    if (current.length <= pen.visible) return undefined;
    const reveal = () => setState({ shown: [...pen.shown, 0], visible: pen.visible + 1 });
    if (target === undefined) {
      reveal();
      return undefined;
    }
    const timer = setTimeout(reveal, PEN_GAP_MS);
    return () => clearTimeout(timer);
  }, [key, state]);

  if (names === undefined) return SILENT;
  const shown = shownOf(state, names, prefersReducedMotion());
  const at = state.visible - 1;
  const idle = at >= 0 && state.visible === names.length && (shown[at] ?? 0) >= names[at]!.length;
  return { idle, shown, visible: state.visible };
}
