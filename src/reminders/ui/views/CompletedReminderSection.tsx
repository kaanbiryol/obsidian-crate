import { memo, type ReactElement } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { AnimatePresence, motion } from 'motion/react';

import { ReminderMotionRow } from '../../components/ReminderMotionRow';
import { ReminderListPresence } from '../../components/ReminderListPresence';
import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
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
      {reminders.length > 0 && <motion.div
        key="completed-section"
        initial={animationsEnabled ? { height: 0, opacity: 0, overflow: 'hidden' } : false}
        animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
        exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
        transition={animationsEnabled ? { height: REMINDER_SECTION_TRANSITION, opacity: REMINDER_LIST_FADE_TRANSITION } : { duration: 0 }}
        style={{ display: 'flow-root' }}
      >
        <Collapsible.Root open={showCompleted} onOpenChange={onToggle}
          className="completed-reminder-section" data-reminder-scroll-anchor="true"
          data-reminder-id="completed-section" data-reminder-section="section"
        >
          <div className="premium-divider" role="separator" />
          {renderToggleButton
            ? <Collapsible.Trigger render={renderToggleButton({ ...toggleProps, onPress: () => {} }) as ReactElement<Record<string, unknown>>} />
            : <Collapsible.Trigger className="completed-section-toggle w-full justify-between h-10 px-0">
                <span className="reminders-muted-label">Completed ({reminders.length})</span>
                <motion.span animate={{ rotate: showCompleted ? 180 : 0 }}
                  transition={{ duration: animationsEnabled ? 0.2 : 0 }} className="inline-flex">
                  <ThemeIcon size="m" id="chevron-down" />
                </motion.span>
              </Collapsible.Trigger>}
          <Collapsible.Panel className="completed-section-panel" data-no-animation={!animationsEnabled ? '' : undefined}>
            <ReminderPagination pagination={pagination} label="Completed reminders" />
            <ReminderListPresence>
              {pagination.items.map((reminder, index) => <ReminderMotionRow
                key={reminder.id} id={reminder.id} section="completed" animationsEnabled={animationsEnabled}
              >{renderCard(reminder, pagination.start + index)}</ReminderMotionRow>)}
            </ReminderListPresence>
          </Collapsible.Panel>
        </Collapsible.Root>
      </motion.div>}
    </AnimatePresence>
  );
});
