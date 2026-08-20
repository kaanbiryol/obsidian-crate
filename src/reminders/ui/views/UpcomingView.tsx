import React, { useMemo, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { CalendarRange } from 'lucide-react';
import { Divider } from '@heroui/react';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { formatDateHeader } from '../../utils/dateFormatting';
import { ReminderCard } from '../../components/ReminderCard';
import { EmptyState } from '../../components/EmptyState';
import { buildUpcomingViewModel } from './viewModels';
import { STAGGERED_CARD_ANIMATION } from '../layoutConstants';

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
  className = ''
}: UpcomingViewProps) {
  const { upcomingReminders, dateGroups } = useMemo(() => {
    return buildUpcomingViewModel(reminders, days);
  }, [reminders, days]);

  // Default card renderer
  const defaultRenderCard = (reminder: Reminder, index: number) => (
    <ReminderCard
      reminder={reminder}
      index={index}
      animationConfig={{ enabled: false }}
    />
  );

  const cardRenderer = renderCard || defaultRenderCard;

  // When empty, show centered EmptyState
  if (upcomingReminders.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <EmptyState
          icon={CalendarRange}
          title="No upcoming reminders"
          description="Schedule something for the future"
          iconColor="secondary"
          animationConfig={animationConfig}
        />
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full relative ${className}`}>
      <div
        className={`flex-1 overflow-y-auto ios-scroll reminders-view-scroll${hasFab ? ' has-fab' : ''}`}
      >
        <div className="space-y-6">
          {dateGroups.map((group, groupIndex) => (
            <div key={group.date.toISOString()}>
              {groupIndex > 0 && <Divider className="my-4" />}
              <h2
                className="upcoming-date-header"
              >
                {formatDateHeader(group.date)}
              </h2>
              <LayoutGroup>
                <AnimatePresence mode="popLayout" initial={false}>
                  {group.reminders.map((reminder, index) => (
                    <motion.div
                      key={reminder.id}
                      layout="position"
                      custom={index}
                      initial={animationConfig.enabled ? STAGGERED_CARD_ANIMATION.initial : false}
                      animate={animationConfig.enabled ? STAGGERED_CARD_ANIMATION.animate(index) : { opacity: 1 }}
                      exit={animationConfig.enabled ? STAGGERED_CARD_ANIMATION.exit : undefined}
                      className="mb-2"
                    >
                      {cardRenderer(reminder, index)}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </LayoutGroup>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
