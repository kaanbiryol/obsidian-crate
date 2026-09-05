import React, { useMemo, useState, useId, memo } from 'react';
import { motion, LayoutGroup } from 'framer-motion';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ReminderCard } from '../../components/ReminderCard';
import { ReorderableReminderList } from '../../components/ReorderableReminderList';
import { EmptyState } from '../../components/EmptyState';
import { buildInboxViewModel } from './viewModels';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useReminderOrder } from '../hooks/useReminderOrder';
import { useStableReminderScroll } from '../hooks/useStableReminderScroll';
import {
  CompletedReminderSection,
  type CompletedSectionToggleProps,
} from './CompletedReminderSection';

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
  reorderInteraction?: 'handle' | 'long-press';
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
  reorderInteraction = 'handle',
  colorScheme = 'dark',
}: InboxViewProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  const layoutGroupId = useId();

  const { active, completed } = useMemo(() => buildInboxViewModel(reminders), [reminders]);
  const order = useReminderOrder(active, onReorder, onReorderDragActiveChange);
  const scrollRef = useStableReminderScroll(order.isDragging);

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

  if (!hasContent) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <EmptyState
          icon="inbox"
          title="Your inbox is empty"
          description="Add a new reminder to get started"
          iconColor="primary"
          animationConfig={animationConfig}
        />
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full relative ${className}`}>
      <motion.div
        ref={scrollRef}
        layoutScroll
        className={`flex-1 overflow-y-auto space-y-2 ios-scroll reminders-view-scroll${hasFab ? ' has-fab' : ''}`}
      >
        <LayoutGroup id={layoutGroupId}>
          <ReorderableReminderList
            reminders={order.displayedOrder}
            onReorder={order.onReorder}
            onReorderCommit={order.onCommit}
            onDragActiveChange={order.onDragChange}
            renderCard={cardRenderer}
            interaction={reorderInteraction}
            animationsEnabled={animationConfig.enabled}
          />

          <CompletedReminderSection
            reminders={completed}
            showCompleted={showCompleted}
            onToggle={() => setShowCompleted((previous) => !previous)}
            renderCard={cardRenderer}
            renderToggleButton={renderToggleButton}
            animationConfig={animationConfig}
          />
        </LayoutGroup>
      </motion.div>
    </div>
  );
});
