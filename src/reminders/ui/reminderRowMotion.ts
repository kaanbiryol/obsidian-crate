import type { MotionProps } from 'motion/react';
import { REMINDER_LIST_FADE_TRANSITION, REMINDER_SECTION_TRANSITION } from './layoutConstants';

/** Animate occupied space, so fading cards never overlap their neighbors. */
export function reminderRowMotion(enabled: boolean): MotionProps {
  return {
    initial: enabled ? { height: 0, marginBottom: 0, opacity: 0, overflow: 'hidden' } : false,
    animate: {
      height: 'auto', marginBottom: 8, opacity: 1,
      transitionEnd: { overflow: 'visible' },
    },
    exit: { height: 0, marginBottom: 0, opacity: 0, overflow: 'hidden' },
    transition: enabled ? {
      height: REMINDER_SECTION_TRANSITION,
      marginBottom: REMINDER_SECTION_TRANSITION,
      opacity: REMINDER_LIST_FADE_TRANSITION,
    } : { duration: 0 },
    style: { display: 'flow-root' },
  };
}
