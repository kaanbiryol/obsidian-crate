import React, { useMemo, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { formatDateHeader } from '../../utils/dateFormatting';
import { ReminderCard } from '../../components/ReminderCard';
import { EmptyState } from '../../components/EmptyState';
import { buildUpcomingViewModel } from './viewModels';
import { STAGGERED_CARD_ANIMATION } from '../layoutConstants';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useStableReminderScroll } from '../hooks/useStableReminderScroll';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

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
  const scrollRef = useStableReminderScroll();
  const { upcomingReminders, dateGroups } = useMemo(() => {
    return buildUpcomingViewModel(reminders, days);
  }, [reminders, days]);
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

  // When empty, show centered EmptyState
  if (upcomingReminders.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <EmptyState
          icon="calendar-range"
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
        ref={scrollRef}
        className={`flex-1 overflow-y-auto ios-scroll reminders-view-scroll${hasFab ? ' has-fab' : ''}`}
      >
        <div className="space-y-6">
          {dateGroups.map((group, groupIndex) => (
            <div key={group.date.toISOString()}>
              {groupIndex > 0 && <div className="my-4 premium-divider" role="separator" />}
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
					  layout={enableListAnimations ? 'position' : false}
                      custom={index}
					  initial={enableListAnimations ? STAGGERED_CARD_ANIMATION.initial : false}
					  animate={enableListAnimations ? STAGGERED_CARD_ANIMATION.animate(index) : { opacity: 1 }}
					  exit={enableListAnimations ? STAGGERED_CARD_ANIMATION.exit : undefined}
					  className="mb-2 reminder-render-item"
                      data-reminder-scroll-anchor="true"
                      data-reminder-id={reminder.id}
                      data-reminder-section="active"
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
