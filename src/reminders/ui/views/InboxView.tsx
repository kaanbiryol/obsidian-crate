import React, { useMemo, useState, useCallback, useEffect, useRef, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ReminderCard } from '../../components/ReminderCard';
import { ReorderableReminderList } from '../../components/ReorderableReminderList';
import { EmptyState } from '../../components/EmptyState';
import { buildInboxViewModel } from './viewModels';
import {
  REMINDER_LIST_LAYOUT_TRANSITION,
  SPRING_CONFIG_BOUNCY,
} from '../layoutConstants';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useStableReminderScroll } from '../hooks/useStableReminderScroll';
import { ThemeIcon } from '../../components/theme-icon';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

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
  renderToggleButton?: (props: {
    onPress: () => void;
    showCompleted: boolean;
    count: number;
  }) => React.ReactNode;
  /** Callback when reminders are reordered via drag */
  onReorder?: (orderedIds: string[]) => void;
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
  const animationsEnabled = animationConfig.enabled && !useObsidianReducedMotion();
  const [showCompleted, setShowCompleted] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const scrollRef = useStableReminderScroll(isReordering);

  const { active, completed } = useMemo(() => buildInboxViewModel(reminders), [reminders]);
  const previousCompletedCountRef = useRef(completed.length);
  const shouldAnimateCompletedReveal = previousCompletedCountRef.current > 0;

  useEffect(() => {
    previousCompletedCountRef.current = completed.length;
  }, [completed.length]);

  // Local state for optimistic reorder (visual only during drag)
  const [localOrder, setLocalOrder] = useState<Reminder[]>(active);

  useEffect(() => {
    if (!isReordering) setLocalOrder(active);
  }, [active, isReordering]);

  // Outside a drag, render the latest view-model order immediately. Waiting for
  // the synchronization effect adds an intermediate frame where a reminder has
  // left Completed but has not entered the active list yet, which breaks the
  // shared-layout measurement and makes neighboring cards jump.
  const displayedOrder = isReordering ? localOrder : active;

  const handleReorderCommit = useCallback((orderedIds: string[]) => {
    onReorder?.(orderedIds);
  }, [onReorder]);

  const handleDragActiveChange = useCallback((active: boolean) => {
    setIsReordering(active);
    onReorderDragActiveChange?.(active);
  }, [onReorderDragActiveChange]);

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
        <LayoutGroup id="inbox-reminder-sections">
          <ReorderableReminderList
            reminders={displayedOrder}
            onReorder={setLocalOrder}
            onReorderCommit={handleReorderCommit}
            onDragActiveChange={handleDragActiveChange}
            renderCard={cardRenderer}
            interaction={reorderInteraction}
          />

          {/* Completed section */}
          {completed.length > 0 && (
            <div
              className="mt-6 pb-4"
              data-reminder-scroll-anchor="true"
              data-reminder-id="completed-section"
              data-reminder-section="section"
            >
            <div className="mb-3 premium-divider" role="separator" />
            {renderToggleButton ? (
              renderToggleButton({
                onPress: () => setShowCompleted(prev => !prev),
                showCompleted,
                count: completed.length
              })
            ) : (
              <button
				type="button"
				onClick={() => setShowCompleted(prev => !prev)}
				className="completed-section-toggle w-full justify-between h-10 px-0"
			  >
				<span
				  className="reminders-muted-label"
				>
				  Completed ({completed.length})
				</span>
				{
				  <motion.span
                    animate={{ rotate: showCompleted ? 180 : 0 }}
                    transition={animationsEnabled ? { duration: 0.2, ease: 'easeOut' } : { duration: 0 }}
                    className="inline-flex"
                  >
                    <ThemeIcon size="m" id="chevron-down" />
				  </motion.span>
				}
			  </button>
            )}

            <AnimatePresence mode="popLayout" initial={false}>
              {showCompleted && (
                <motion.div
                  initial={animationsEnabled && shouldAnimateCompletedReveal
                    ? { opacity: 0, height: 0, overflow: 'hidden' }
                    : false}
                  animate={{
                    opacity: 1,
                    height: 'auto',
                    transition: {
                      height: { type: 'spring', ...SPRING_CONFIG_BOUNCY },
                      opacity: { duration: 0.2, delay: 0.05 }
                    },
                    transitionEnd: { overflow: 'visible' }
                  }}
                  exit={{
                    opacity: 0,
                    height: 0,
                    overflow: 'hidden',
                    transition: {
                      height: { duration: 0.2 },
                      opacity: { duration: 0.15 }
                    }
                  }}
                  className="mt-3"
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    {completed.map((reminder, index) => (
                      <motion.div
                        key={reminder.id}
                        initial={false}
                        animate={{ opacity: 1 }}
                        exit={animationsEnabled ? {
                          opacity: 0,
                          transition: { duration: 0.14, ease: 'easeOut' }
                        } : undefined}
                        transition={{
                          opacity: { duration: 0.14, ease: 'easeOut' },
                        }}
						className="mb-2 reminder-render-item"
                        data-reminder-scroll-anchor="true"
                        data-reminder-id={reminder.id}
                        data-reminder-section="completed"
                      >
                        <motion.div
                          layoutId={animationsEnabled ? `reminder-card-${reminder.id}` : undefined}
                          layoutCrossfade={false}
                          layout={animationsEnabled ? 'position' : false}
                          layoutDependency={reminder.id}
                          transition={{ layout: REMINDER_LIST_LAYOUT_TRANSITION }}
                        >
                          {cardRenderer(reminder, index)}
                        </motion.div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
            </div>
          )}
        </LayoutGroup>
      </motion.div>
    </div>
  );
});
