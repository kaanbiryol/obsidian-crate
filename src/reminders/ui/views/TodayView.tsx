import React, { useMemo, useState, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Calendar } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ReminderCard } from '../../components/ReminderCard';
import { EmptyState } from '../../components/EmptyState';
import { ProjectCompletedSection } from './ProjectCompletedSection';
import { buildTodayViewModel } from './viewModels';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITH_FAB_CSS,
  CARD_ANIMATION
} from '../layoutConstants';

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
 * Displays reminders due today, overdue reminders, and completed reminders due today
 */
export const TodayView = memo(function TodayView({
  reminders,
  animationConfig = { enabled: true },
  renderCard,
  hasFab = true,
  className = ''
}: TodayViewProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  const { active, completed } = useMemo(() => buildTodayViewModel(reminders), [reminders]);
  const hasContent = active.length > 0 || completed.length > 0;

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
  if (!hasContent) {
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
            {active.map((reminder, index) => (
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

        <ProjectCompletedSection
          reminders={completed}
          showCompleted={showCompleted}
          onToggle={() => setShowCompleted((previous) => !previous)}
          renderCard={cardRenderer}
        />
      </div>
    </div>
  );
});
