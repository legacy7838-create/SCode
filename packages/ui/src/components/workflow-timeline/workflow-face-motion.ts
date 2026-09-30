import type { StepRunStatus } from "@/components/workflow-graph/types.js";

export type FaceState = "waiting" | "scanning" | "content" | "sad";
export type EyeExpression = "dots" | "pill" | "happy" | "sleepy" | "focused" | "sad" | "confused";
export function faceState(status: StepRunStatus | undefined): FaceState {
  return status === "running"
    ? "scanning"
    : status === "done"
      ? "content"
      : status === "failed"
        ? "sad"
        : "waiting";
}
export const BASE_EXPRESSION: Record<FaceState, EyeExpression> = {
  waiting: "dots",
  scanning: "pill",
  content: "happy",
  sad: "sad",
};
const SPECIAL: Record<FaceState, readonly EyeExpression[]> = {
  scanning: ["focused", "confused"],
  waiting: [],
  content: [],
  sad: [],
};

/**
 * A single face has only one pending timer; DOM actions do not trigger a React re-render of the
 * whole workflow.
 */
export function startFaceMotion(face: SVGSVGElement, state: FaceState): () => void {
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = true;
  let rounds = 0;
  let lookingLeft = false;
  let previous: EyeExpression | undefined;
  const random = (min: number, max: number) => min + Math.random() * (max - min);
  const later = (delay: number, action: () => void) => {
    timer = setTimeout(action, delay);
  };
  const motion = (value: string) => {
    face.dataset.motion = value;
  };
  const base = () => {
    face.dataset.expression = BASE_EXPRESSION[state];
    motion("idle");
    face.style.setProperty("--wf-face-x", "0px");
    face.style.setProperty("--wf-face-y", state === "sad" ? "0.3px" : "0px");
  };
  const pause = () => {
    motion("idle");
    later(
      state === "waiting"
        ? random(1500, 3000)
        : state === "scanning"
          ? random(1500, 3500)
          : state === "sad"
            ? random(1800, 4000)
            : random(6000, 10000),
      cycle,
    );
  };
  // Change the outline when the eyes are closed to avoid jumping directly from round eyes to slanted eyes; use the same transition when returning to the basic expression.
  const morph = (expression: EyeExpression, next: () => void) => {
    motion("morph");
    later(80, () => {
      face.dataset.expression = expression;
      later(100, () => {
        motion("idle");
        next();
      });
    });
  };
  const maybeExpression = () => {
    rounds++;
    const probability = state === "scanning" ? 0.45 : 0.25;
    if (rounds < 2 || Math.random() >= probability) {
      pause();
      return;
    }
    const choices = SPECIAL[state].filter((e) => e !== previous);
    // The resulting state of only one occasional expression must go through two rounds of basic actions, and faces cannot be changed continuously.
    const pool = choices.length ? choices : SPECIAL[state];
    const expression = pool[Math.floor(Math.random() * pool.length)]!;
    previous = expression;
    rounds = 0;
    const hold = expression === "confused" ? random(2200, 3800) : random(800, 1800);
    morph(expression, () => later(hold, () => morph(BASE_EXPRESSION[state], pause)));
  };
  const glance = () => {
    motion("glance");
    // Panning has to be swapped to the other side of the face; the old ±0.65 nudge only looks like eye jitters, with no visible left-right dwell.
    lookingLeft = !lookingLeft;
    face.style.setProperty("--wf-face-x", lookingLeft ? "-4px" : "0px");
    later(360, maybeExpression);
  };
  function cycle() {
    if (state === "waiting") {
      motion("dots-wave");
      later(900, pause);
      return;
    }
    if (state === "sad") {
      const floats = Math.random() < 0.5 ? 1 : 2;
      face.style.setProperty("--wf-face-floats", String(floats));
      motion("float");
      later(floats * 600, () => {
        if (Math.random() >= 0.4) {
          pause();
          return;
        }
        morph("focused", () => {
          const shakes = 3 + Math.floor(Math.random() * 3);
          face.style.setProperty("--wf-face-shakes", String(shakes));
          motion("shake");
          later(shakes * 90, () => {
            motion("idle");
            later(random(500, 1000), () => morph("sad", pause));
          });
        });
      });
      return;
    }
    if (state === "content") {
      const hops = Math.random() < 0.5 ? 2 : 3;
      face.style.setProperty("--wf-face-hops", String(hops));
      motion("hop");
      later(hops * 240, () => {
        face.dataset.expression = "pill";
        motion("idle");
        later(250, () => {
          const duration = random(260, 320);
          face.style.setProperty("--wf-face-blinks", "1");
          face.style.setProperty("--wf-face-blink-time", `${duration}ms`);
          motion("blink");
          later(duration, () => {
            face.dataset.expression = "happy";
            pause();
          });
        });
      });
    } else {
      const blinks = Math.random() < 0.5 ? 2 : 3;
      const duration = state === "scanning" ? random(200, 260) : random(260, 320);
      face.style.setProperty("--wf-face-blinks", String(blinks));
      face.style.setProperty("--wf-face-blink-time", `${duration}ms`);
      motion("blink");
      later(duration * blinks, glance);
    }
  }
  const restart = () => {
    clearTimeout(timer);
    timer = undefined;
    rounds = 0;
    lookingLeft = false;
    base();
    if (!document.hidden && !media?.matches && visible) later(random(1200, 2800), cycle);
  };
  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          const next = entries[0]?.isIntersecting ?? true;
          if (next !== visible) {
            visible = next;
            restart();
          }
        });
  observer?.observe(face);
  document.addEventListener("visibilitychange", restart);
  media?.addEventListener?.("change", restart);
  restart();
  return () => {
    clearTimeout(timer);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", restart);
    media?.removeEventListener?.("change", restart);
    base();
  };
}
