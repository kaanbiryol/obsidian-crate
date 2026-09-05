import React, { useMemo, memo } from 'react';

import { ReminderListLayout } from './ReminderListLayout';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ReminderListPresence } from '../../components/ReminderListPresence';
import { ReminderCard } from '../../components/ReminderCard';
import { EmptyState } from '../../components/EmptyState';
import { buildTodayViewModel } from './viewModels';
import { ReminderMotionRow } from '../../components/ReminderMotionRow';
import type { ProjectColorScheme } from '../../utils/projectColors';
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
  const reduceMotion = useObsidianReducedMotion();
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

  return (
    <ReminderListLayout
      className={className}
      hasFab={hasFab}
      hasContent={hasContent}
      renderCard={cardRenderer}
      animationConfig={animationConfig}
      completed={completed}
      emptyState={
        <EmptyState
            icon="calendar"
            title="Nothing due today"
            description="Enjoy your free time!"
            iconColor="warning"
            animationConfig={animationConfig}
          />
      }
    >
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
    </ReminderListLayout>
  );
});
