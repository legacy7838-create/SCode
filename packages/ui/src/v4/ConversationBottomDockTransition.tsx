import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX = 32;
const CONVERSATION_BOTTOM_DOCK_ENTER_SCALE = 0.96;
const CONVERSATION_BOTTOM_DOCK_EXIT_SCALE = 0.97;
const CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS = 0.26;
const CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS = 0.18;
const CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING = [0.23, 1, 0.32, 1] as const;

const CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM = "translate3d(0, 0, 0) scale(1)";
const CONVERSATION_BOTTOM_DOCK_ENTER_TRANSFORM = `translate3d(0, ${CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX}px, 0) scale(${CONVERSATION_BOTTOM_DOCK_ENTER_SCALE})`;
const CONVERSATION_BOTTOM_DOCK_EXIT_TRANSFORM = `translate3d(0, ${CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX}px, 0) scale(${CONVERSATION_BOTTOM_DOCK_EXIT_SCALE})`;

function resolveConversationBottomDockMotion(prefersReducedMotion: boolean) {
  if (prefersReducedMotion) {
    return {
      initial: false as const,
      animate: {
        opacity: 1,
        transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
        transition: { duration: 0 },
      },
      exit: {
        opacity: 1,
        transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
        transition: { duration: 0 },
      },
    };
  }

  return {
    initial: {
      opacity: 0,
      transform: CONVERSATION_BOTTOM_DOCK_ENTER_TRANSFORM,
    },
    animate: {
      opacity: 1,
      transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
      transition: {
        duration: CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS,
        ease: CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING,
      },
    },
    exit: {
      opacity: 0,
      transform: CONVERSATION_BOTTOM_DOCK_EXIT_TRANSFORM,
      transition: {
        duration: CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS,
        ease: CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING,
      },
    },
  };
}

export function ConversationBottomDockTransition({
  mode,
  children,
}: {
  mode: "chat" | "confirmation";
  children: ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion() === true;
  const motionConfig = resolveConversationBottomDockMotion(prefersReducedMotion);

  return (
    <div data-testid="conversation-bottom-dock-transition" className="grid w-full">
      {/* The chat and confirmation area have different heights; they share the grid unit and are aligned at the bottom to avoid the exit layer jumping first and then animating when the parent height is switched.*/}
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={mode}
          data-testid="conversation-bottom-dock-transition-layer"
          data-conversation-bottom-dock-mode={mode}
          // The grid sub-item defaults to min-width:auto, and the minimum size is equal to the min-content of the content;
          // The implicit column track is auto, and its lower limit is held up by this minimum size, so when the panel shrinks composer
          // Still press min-content (about 465px) to expand the track, and the right side will be cropped after it exceeds the width of the container.
          // min-w-0 turns off the automatic minimum size so that the track can shrink with the container.
          className="col-start-1 row-start-1 w-full min-w-0 origin-bottom self-end will-change-transform"
          initial={motionConfig.initial}
          animate={motionConfig.animate}
          exit={motionConfig.exit}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
