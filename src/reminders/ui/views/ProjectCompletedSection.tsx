import React, { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import type { Reminder } from '../../types/reminder';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { CARD_ANIMATION } from '../layoutConstants';
import { ThemeIcon } from '../../components/theme-icon';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

export const ProjectCompletedSection = memo(function ProjectCompletedSection({
  reminders,
  showCompleted,
  onToggle,
  renderCard,
}: {
  reminders: Reminder[];
  showCompleted: boolean;
  onToggle: () => void;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
}) {
  const reduceMotion = useObsidianReducedMotion();

  if (reminders.length === 0) {
    return null;
  }

  return (
    <div
      className="mt-6 pb-4"
      data-reminder-scroll-anchor="true"
      data-reminder-id="completed-section"
      data-reminder-section="section"
    >
      <div className="premium-divider" />
      <ShadowDOMNativeButton
		onClick={onToggle}
		className="completed-section-toggle w-full justify-between h-10 px-0"
	  >
		<span className="reminders-muted-label">
		  Completed ({reminders.length})
		</span>
		{
		  <motion.span
            animate={{ rotate: showCompleted ? 180 : 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
            className="inline-flex"
          >
            <ThemeIcon size="m" id="chevron-down" />
		  </motion.span>
		}
	  </ShadowDOMNativeButton>

      <AnimatePresence mode="popLayout" initial={false}>
        {showCompleted && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={reduceMotion ? { opacity: 1, height: 'auto' } : {
              opacity: 1,
              height: 'auto',
              transition: {
                height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                opacity: { duration: 0.2, delay: 0.05 }
              }
            }}
            exit={reduceMotion ? undefined : {
              opacity: 0,
              height: 0,
              transition: {
                height: { duration: 0.2 },
                opacity: { duration: 0.15 }
              }
            }}
            className="mt-3 overflow-hidden"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {reminders.map((reminder, index) => (
                <motion.div
                  key={reminder.id}
                  layoutId={reduceMotion ? undefined : `reminder-card-${reminder.id}`}
                  layout={reduceMotion ? false : 'position'}
                  initial={false}
                  animate={{ opacity: 1 }}
                  exit={reduceMotion ? undefined : { ...CARD_ANIMATION.exit, x: 20 }}
				  className="premium-reminder-card-wrapper reminder-render-item"
                  data-reminder-scroll-anchor="true"
                  data-reminder-id={reminder.id}
                  data-reminder-section="completed"
                >
                  {renderCard(reminder, index)}
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
