import type { ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { reminderRowMotion } from '../ui/reminderRowMotion';

export function ReminderMotionRow({
  id, section, animationsEnabled, children,
}: {
  id: string;
  section: 'active' | 'completed';
  animationsEnabled: boolean;
  children: ReactNode;
}) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      {...reminderRowMotion(animationsEnabled)}
      className="reminder-render-item"
      data-reminder-scroll-anchor={isPresent ? 'true' : undefined}
      data-reminder-id={id}
      data-reminder-section={section}
      aria-hidden={!isPresent || undefined}
      inert={!isPresent}
    >
      {children}
    </motion.div>
  );
}
