import React, { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

import type { Reminder } from '../../types/reminder';
import { ShadowDOMButton } from '../../components/ShadowDOMButton';
import { CARD_ANIMATION } from '../layoutConstants';

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
  if (reminders.length === 0) {
    return null;
  }

  return (
    <div className="mt-6 pb-4">
      <div className="premium-divider" />
      <ShadowDOMButton
        variant="light"
        onPress={onToggle}
        className="w-full justify-between h-10 px-0"
        endContent={
          <motion.span
            animate={{ rotate: showCompleted ? 180 : 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="inline-flex"
          >
            <ChevronDown size={18} />
          </motion.span>
        }
      >
        <span
          className="text-sm font-semibold"
          style={{ color: 'var(--text-muted)' }}
        >
          Completed ({reminders.length})
        </span>
      </ShadowDOMButton>

      <AnimatePresence mode="popLayout" initial={false}>
        {showCompleted && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{
              opacity: 1,
              height: 'auto',
              transition: {
                height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                opacity: { duration: 0.2, delay: 0.05 }
              }
            }}
            exit={{
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
                  initial={false}
                  animate={{ opacity: 1 }}
                  exit={{ ...CARD_ANIMATION.exit, x: 20 }}
                  className="premium-reminder-card-wrapper"
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
