import React, { useMemo, useState, useId, memo } from 'react';
import { motion, LayoutGroup } from 'framer-motion';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ReminderListPresence } from '../../components/ReminderListPresence';
import { ReminderCard } from '../../components/ReminderCard';
import { EmptyState } from '../../components/EmptyState';
import { CompletedReminderSection } from './CompletedReminderSection';
import { buildTodayViewModel } from './viewModels';
import { ReminderMotionRow } from '../../components/ReminderMotionRow';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useStableReminderScroll } from '../hooks/useStableReminderScroll';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

export interface TodayViewProps {
  reminders: Reminder[];
  animationConfig?: AnimationConfig;
  /** Custom render function for reminder cards (for platform-specific wrappers) */
  renderCard?: (reminder: Reminder, index: number) => React.ReactNode;
  /** Whether to use fixed bottom padding (for views with FAB) */
  hasFab?: boolean;
  /** Custom class name for the container */
  className?: string;
  colorScheme?: ProjectColorScheme;
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
  className = '',
  colorScheme = 'dark',
}: TodayViewProps) {
  const layoutGroupId = useId();
  const reduceMotion = useObsidianReducedMotion();
  const [showCompleted, setShowCompleted] = useState(false);
  const scrollRef = useStableReminderScroll();
  const { active, completed } = useMemo(() => buildTodayViewModel(reminders), [reminders]);
  const enableListAnimations = animationConfig.enabled && !reduceMotion && active.length <= 80;
  const hasContent = active.length > 0 || completed.length > 0;

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
  if (!hasContent) {
    return (
      <div className={`flex flex-col h-full relative ${className}`}>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon="calendar"
            title="Nothing due today"
            description="Enjoy your free time!"
            iconColor="warning"
            animationConfig={animationConfig}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full relative ${className}`}>
      <motion.div
        layoutScroll
        ref={scrollRef}
        className={`flex-1 overflow-y-auto space-y-2 ios-scroll reminders-view-scroll${hasFab ? ' has-fab' : ''}`}
      >
        <LayoutGroup id={layoutGroupId}>
          <ReminderListPresence>
            {active.map((reminder, index) => (
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

          <CompletedReminderSection
            reminders={completed}
            showCompleted={showCompleted}
            onToggle={() => setShowCompleted((previous) => !previous)}
            renderCard={cardRenderer}
            animationConfig={animationConfig}
          />
        </LayoutGroup>
      </motion.div>
    </div>
  );
});
