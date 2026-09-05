import React, { useMemo, memo } from 'react';

import { ReminderListLayout } from './ReminderListLayout';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ReminderCard } from '../../components/ReminderCard';
import { ReorderableReminderList } from '../../components/ReorderableReminderList';
import { EmptyState } from '../../components/EmptyState';
import { buildInboxViewModel } from './viewModels';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useReminderOrder } from '../hooks/useReminderOrder';
import type { CompletedSectionToggleProps } from './CompletedReminderSection';

export interface InboxViewProps {
  reminders: Reminder[];
  animationConfig?: AnimationConfig;
  /** Custom render function for reminder cards (for platform-specific wrappers) */
  renderCard?: (reminder: Reminder, index: number) => React.ReactNode;
  /** Whether to use fixed bottom padding (for views with FAB) */
  hasFab?: boolean;
  /** Custom class name for the container */
  className?: string;
  /** Custom render function for the completed section toggle button (for Shadow DOM compatibility) */
  renderToggleButton?: (props: CompletedSectionToggleProps) => React.ReactNode;
  /** Callback when reminders are reordered via drag */
  onReorder?: (orderedIds: string[]) => Promise<void> | void;
  onReorderDragActiveChange?: (active: boolean) => void;
  reorderInteraction?: 'drag' | 'long-press';
  colorScheme?: ProjectColorScheme;
}

/**
 * Shared Inbox view component
 * Displays reminders from the Inbox project with collapsible completed section
 */
export const InboxView = memo(function InboxView({
  reminders,
  animationConfig = { enabled: true },
  renderCard,
  hasFab = true,
  className = '',
  renderToggleButton,
  onReorder,
  onReorderDragActiveChange,
  reorderInteraction = 'drag',
  colorScheme = 'dark',
}: InboxViewProps) {
  const { active, completed } = useMemo(() => buildInboxViewModel(reminders), [reminders]);
  const order = useReminderOrder(active, onReorder, onReorderDragActiveChange);

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
      isDragging={order.isDragging}
      renderToggleButton={renderToggleButton}
      emptyState={
        <EmptyState
          icon="inbox"
          title="Your inbox is empty"
          description="Add a new reminder to get started"
          iconColor="primary"
          animationConfig={animationConfig}
        />
      }
    >
      <ReorderableReminderList
        reminders={order.displayedOrder}
        onReorder={order.onReorder}
        onReorderCommit={order.onCommit}
        onDragActiveChange={order.onDragChange}
        renderCard={cardRenderer}
        interaction={reorderInteraction}
        animationsEnabled={animationConfig.enabled}
      />
    </ReminderListLayout>
  );
});
