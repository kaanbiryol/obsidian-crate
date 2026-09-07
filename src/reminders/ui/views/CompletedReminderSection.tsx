import { memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { ReminderMotionRow } from '../../components/ReminderMotionRow';
import { ReminderListPresence } from '../../components/ReminderListPresence';
import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ThemeIcon } from '../../components/theme-icon';
import {
  REMINDER_LIST_FADE_TRANSITION,
  REMINDER_SECTION_TRANSITION,
} from '../layoutConstants';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { ReminderPagination, useReminderPagination } from '../reminder-pagination';

export interface CompletedSectionToggleProps {
  onPress: () => void;
  showCompleted: boolean;
  count: number;
}

interface CompletedReminderSectionProps {
  reminders: Reminder[];
  showCompleted: boolean;
  onToggle: () => void;
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  renderToggleButton?: (props: CompletedSectionToggleProps) => React.ReactNode;
  animationConfig?: AnimationConfig;
}

export const CompletedReminderSection = memo(function CompletedReminderSection({
  reminders,
  showCompleted,
  onToggle,
  renderCard,
  renderToggleButton,
  animationConfig = { enabled: true },
}: CompletedReminderSectionProps) {
  const reduceMotion = useObsidianReducedMotion();
  const pagination = useReminderPagination(reminders);
  const animationsEnabled = animationConfig.enabled && !reduceMotion;

  const toggleProps: CompletedSectionToggleProps = {
    onPress: onToggle,
    showCompleted,
    count: reminders.length,
  };

  return (
        <AnimatePresence initial={false}>
        {reminders.length > 0 && (
        <motion.div
            key="completed-section"
            initial={animationsEnabled ? { height: 0, opacity: 0, overflow: 'hidden' } : false}
            animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
            exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
            transition={animationsEnabled ? { height: REMINDER_SECTION_TRANSITION, opacity: REMINDER_LIST_FADE_TRANSITION } : { duration: 0 }}
            style={{ display: 'flow-root' }}
        >
        <div
      className="completed-reminder-section"
      data-reminder-scroll-anchor="true"
      data-reminder-id="completed-section"
      data-reminder-section="section"
    >
      <div className="premium-divider" role="separator" />
      {renderToggleButton ? (
        renderToggleButton(toggleProps)
      ) : (
        <ShadowDOMNativeButton
          onClick={onToggle}
          className="completed-section-toggle w-full justify-between h-10 px-0"
          aria-expanded={showCompleted}
        >
          <span className="reminders-muted-label">
            Completed ({reminders.length})
          </span>
          <motion.span
            animate={{ rotate: showCompleted ? 180 : 0 }}
            transition={animationsEnabled ? { duration: 0.2, ease: 'easeOut' } : { duration: 0 }}
            className="inline-flex"
          >
            <ThemeIcon size="m" id="chevron-down" />
          </motion.span>
        </ShadowDOMNativeButton>
      )}

      <AnimatePresence initial={false}>
        {showCompleted && (
          <motion.div
            initial={animationsEnabled
              ? { opacity: 0, height: 0, overflow: 'hidden' }
              : false}
            animate={{
              opacity: 1,
              height: 'auto',
              transition: animationsEnabled ? {
                height: REMINDER_SECTION_TRANSITION,
                opacity: REMINDER_LIST_FADE_TRANSITION,
              } : { duration: 0 },
              transitionEnd: { overflow: 'visible' },
            }}
            exit={animationsEnabled ? {
              opacity: 0,
              height: 0,
              overflow: 'hidden',
              transition: {
                height: REMINDER_SECTION_TRANSITION,
                opacity: REMINDER_LIST_FADE_TRANSITION,
              },
            } : undefined}
            className="mt-3"
          >
            <ReminderPagination pagination={pagination} label="Completed reminders" />
            <ReminderListPresence>
              {pagination.items.map((reminder, index) => (
                                <ReminderMotionRow
                                    key={reminder.id}
                                    id={reminder.id}
                                    section="completed"
                                    animationsEnabled={animationsEnabled}
                                >
                                    {renderCard(reminder, pagination.start + index)}
                </ReminderMotionRow>
              ))}
            </ReminderListPresence>
          </motion.div>
        )}
      </AnimatePresence>
        </div>
        </motion.div>
        )}
        </AnimatePresence>
  );
});
