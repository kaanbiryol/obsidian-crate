import React, { useMemo, memo } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';

import { ReminderListLayout } from './ReminderListLayout';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { formatDateHeader } from '../../utils/dateFormatting';
import { ReminderListPresence } from '../../components/ReminderListPresence';
import { ReminderCard } from '../../components/ReminderCard';
import { EmptyState } from '../../components/EmptyState';
import { buildUpcomingViewModel } from './viewModels';
import { ReminderMotionRow } from '../../components/ReminderMotionRow';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { reminderRowMotion } from '../reminderRowMotion';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { ReminderPagination, useReminderPagination } from '../reminder-pagination';
import { groupRemindersByDate } from '../../utils/reminderSort';
import { useReminderClock } from '../useReminderClock';

export interface UpcomingViewProps {
  reminders: Reminder[];
  animationConfig?: AnimationConfig;
  /** Number of days to show upcoming reminders for */
  days?: number;
  /** Custom render function for reminder cards (for platform-specific wrappers) */
  renderCard?: (reminder: Reminder, index: number) => React.ReactNode;
  /** Whether to use fixed bottom padding (for views with FAB) */
  hasFab?: boolean;
  /** Custom class name for the container */
  className?: string;
  colorScheme?: ProjectColorScheme;
}

/**
 * Shared Upcoming view component
 * Displays reminders grouped by date for the next N days
 */
export const UpcomingView = memo(function UpcomingView({
  reminders,
  animationConfig = { enabled: true },
  days = 7,
  renderCard,
  hasFab = true,
  className = '',
  colorScheme = 'dark',
}: UpcomingViewProps) {
  const reduceMotion = useObsidianReducedMotion();
  const clock = useReminderClock(reminders);
  const { upcomingReminders } = useMemo(() => {
    return buildUpcomingViewModel(reminders, days, clock.now);
  }, [reminders, days, clock]);
  const pagination = useReminderPagination(upcomingReminders, days);
  const dateGroups = useMemo(() => groupRemindersByDate(pagination.items), [pagination.items]);
  const enableListAnimations = animationConfig.enabled && !reduceMotion && upcomingReminders.length <= 80;

  // Default card renderer
  const defaultRenderCard = (reminder: Reminder, index: number) => (
    <ReminderCard
      reminder={reminder}
      index={index}
      animationConfig={{ enabled: false }}
      colorScheme={colorScheme}
    />
  );

  const cardRenderer = renderCard || defaultRenderCard;

  return (
    <ReminderListLayout
      className={className}
      hasFab={hasFab}
      hasContent={upcomingReminders.length > 0}
      renderCard={cardRenderer}
      animationConfig={animationConfig}
      emptyState={
        <EmptyState
          icon="calendar-range"
          title="No upcoming reminders"
          description="Schedule something for the future"
          iconColor="secondary"
          animationConfig={animationConfig}
        />
      }
    >
      <div className="space-y-6">
        <ReminderPagination pagination={pagination} label="Upcoming reminders" />
        <AnimatePresence initial={false}>
          {dateGroups.map((group, groupIndex) => (
            <motion.div key={group.date.toISOString()} {...reminderRowMotion(enableListAnimations)}>
              {groupIndex > 0 && <div className="my-4 premium-divider" role="separator" />}
              <h2
                className="upcoming-date-header"
              >
                {formatDateHeader(group.date, undefined, clock.now)}
              </h2>
              <LayoutGroup>
                <ReminderListPresence>
                  {group.reminders.map((reminder, index) => (
                    <ReminderMotionRow
                      key={reminder.id}
                      id={reminder.id}
                      section="active"
                      animationsEnabled={enableListAnimations}
                    >
                      {cardRenderer(reminder, index)}
                    </ReminderMotionRow>
                  ))}
                </ReminderListPresence>
              </LayoutGroup>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ReminderListLayout>
  );
});
