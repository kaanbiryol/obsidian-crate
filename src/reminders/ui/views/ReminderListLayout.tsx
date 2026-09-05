import React, { useId, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import type { Reminder } from '../../types/reminder';
import type { AnimationConfig } from '../../types/componentAdapter';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { REMINDER_LIST_FADE_TRANSITION } from '../layoutConstants';
import { useStableReminderScroll } from '../hooks/useStableReminderScroll';
import { CompletedReminderSection, type CompletedSectionToggleProps } from './CompletedReminderSection';

interface ReminderListLayoutProps {
  children: React.ReactNode;
  hasContent: boolean;
  emptyState: React.ReactNode;
  header?: React.ReactNode;
  className?: string;
  hasFab?: boolean;
  isDragging?: boolean;
  completed?: Reminder[];
  renderCard: (reminder: Reminder, index: number) => React.ReactNode;
  renderToggleButton?: (props: CompletedSectionToggleProps) => React.ReactNode;
  animationConfig: AnimationConfig;
}

/** Common screen body for flat and date-grouped reminder lists. */
export function ReminderListLayout({
  children,
  hasContent,
  emptyState,
  header,
  className = '',
  hasFab = true,
  isDragging = false,
  completed = [],
  renderCard,
  renderToggleButton,
  animationConfig,
}: ReminderListLayoutProps) {
  const reduceMotion = useObsidianReducedMotion();
  const transition = animationConfig.enabled && !reduceMotion ? REMINDER_LIST_FADE_TRANSITION : { duration: 0 };
  const layoutGroupId = useId();
  const scrollRef = useStableReminderScroll(isDragging);
  const [showCompleted, setShowCompleted] = useState(false);

  return (
    <div className={`flex flex-col h-full relative min-h-0 ${className}`}>
      {header}
      <AnimatePresence initial={false} mode="wait">
        {hasContent ? (
          <motion.div
            key="reminder-list"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition}
            ref={scrollRef}
            layoutScroll
            className={`flex-1 min-h-0 overflow-y-auto ios-scroll reminders-view-scroll${hasFab ? ' has-fab' : ''}`}
          >
            <LayoutGroup id={layoutGroupId}>
              {children}
              <CompletedReminderSection
                reminders={completed}
                showCompleted={showCompleted}
                onToggle={() => setShowCompleted(value => !value)}
                renderCard={renderCard}
                renderToggleButton={renderToggleButton}
                animationConfig={animationConfig}
              />
            </LayoutGroup>
          </motion.div>
        ) : (
          <motion.div
            key="empty-state"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition}
            className="flex-1 flex items-center justify-center"
          >{emptyState}</motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
