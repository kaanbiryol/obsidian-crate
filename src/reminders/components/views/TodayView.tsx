import React, { useMemo, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Calendar } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { sortReminders, getTodayReminders, getOverdueReminders } from '../../utils/reminderSort';
import { ReminderCard } from '../ReminderCard';
import { EmptyState } from '../EmptyState';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITH_FAB_CSS,
  CARD_ANIMATION
} from '../../ui/layoutConstants';

export interface TodayViewProps {
  reminders: Reminder[];
  animationConfig?: AnimationConfig;
  /** Custom render function for reminder cards (for platform-specific wrappers) */
  renderCard?: (reminder: Reminder, index: number) => React.ReactNode;
  /** Whether to use fixed bottom padding (for views with FAB) */
  hasFab?: boolean;
  /** Custom class name for the container */
  className?: string;
}

/**
 * Shared Today view component
 * Displays reminders due today and overdue reminders
 */
export const TodayView = memo(function TodayView({
  reminders,
  animationConfig = { enabled: true },
  renderCard,
  hasFab = true,
  className = ''
}: TodayViewProps) {
  const todayReminders = useMemo(() => {
    // Get today's reminders and overdue reminders
    const today = getTodayReminders(reminders);
    const overdue = getOverdueReminders(reminders);

    // Combine today and overdue, then deduplicate and sort
    const combined = [...overdue, ...today];
    const unique = Array.from(new Map(combined.map(r => [r.id, r])).values());

    return sortReminders(unique);
  }, [reminders]);

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
  if (todayReminders.length === 0) {
    return (
      <div className={`flex flex-col h-full relative ${className}`}>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={Calendar}
            title="Nothing due today"
            description="Enjoy your free time!"
            iconColor="warning"
            animationConfig={animationConfig}
          />
        </div>
      </div>
    );
  }

  // Scroll container styles
  const scrollStyle: React.CSSProperties = {
    paddingLeft: `${CONTENT_PADDING_X}px`,
    paddingRight: `${CONTENT_PADDING_X}px`,
    paddingTop: `${CONTENT_PADDING_TOP}px`,
    paddingBottom: hasFab ? SCROLL_PADDING_WITH_FAB_CSS : '16px',
    touchAction: 'pan-y'
  };

  return (
    <div className={`flex flex-col h-full relative ${className}`}>
      <div
        className="flex-1 overflow-y-auto space-y-2 ios-scroll"
        style={scrollStyle}
      >
        <LayoutGroup>
          <AnimatePresence mode="popLayout" initial={false}>
            {todayReminders.map((reminder, index) => (
              <motion.div
                key={reminder.id}
                layout="position"
                initial={animationConfig.enabled ? CARD_ANIMATION.initial : false}
                animate={animationConfig.enabled ? CARD_ANIMATION.animate : { opacity: 1 }}
                exit={animationConfig.enabled ? CARD_ANIMATION.exit : undefined}
                style={{ marginBottom: '0.5rem' }}
              >
                {cardRenderer(reminder, index)}
              </motion.div>
            ))}
          </AnimatePresence>
        </LayoutGroup>
      </div>
    </div>
  );
});

export default TodayView;
