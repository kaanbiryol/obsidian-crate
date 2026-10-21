import type { MotionProps } from 'motion/react';
import { REMINDER_SECTION_TRANSITION } from './layoutConstants';
import { LIST_FADE_TRANSITION } from '../../../ui/shared/navigation/motion';

/** Animate occupied space, so fading cards never overlap their neighbors. */
export function reminderRowMotion(enabled: boolean): MotionProps {
  return {
    initial: enabled ? { height: 0, marginBottom: 0, opacity: 0, overflow: 'hidden' } : false,
    animate: {
      height: 'auto', marginBottom: 'var(--crate-reminder-row-gap, 8px)', opacity: 1,
      transitionEnd: { overflow: 'visible' },
    },
    exit: { height: 0, marginBottom: 0, opacity: 0, overflow: 'hidden' },
    transition: enabled ? {
      height: REMINDER_SECTION_TRANSITION,
      marginBottom: REMINDER_SECTION_TRANSITION,
      opacity: LIST_FADE_TRANSITION,
    } : { duration: 0 },
    style: { display: 'flow-root' },
  };
}
