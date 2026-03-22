import React, { useMemo, useState, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Inbox, ChevronDown } from 'lucide-react';
import { Button, Divider } from '@heroui/react';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { DEFAULT_PROJECT } from '../../utils/constants';
import { sortReminders } from '../../utils/reminderSort';
import { ReminderCard } from '../ReminderCard';
import { EmptyState } from '../EmptyState';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITH_FAB_CSS,
  CARD_ANIMATION,
  SPRING_CONFIG_BOUNCY
} from '../../ui/layoutConstants';

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
  renderToggleButton
}: InboxViewProps) {
  const [showCompleted, setShowCompleted] = useState(false);

  const { active, completed } = useMemo(() => {
    // Filter to only show reminders from the Inbox project
    const inboxReminders = reminders.filter(r =>
      (r.project || DEFAULT_PROJECT) === DEFAULT_PROJECT
    );

    // Use shared sorting for active items: due date → priority
    const sorted = sortReminders(inboxReminders);
    const activeList = sorted.filter(r => !r.completed);

    // Sort completed items by updatedAt (most recently completed at bottom)
    // This prevents reshuffling when items are completed
    const completedList = sorted
      .filter(r => r.completed)
      .sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return timeA - timeB; // Oldest first, newest at bottom
      });

    return { active: activeList, completed: completedList };
  }, [reminders]);

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

  // When empty, show centered EmptyState without scrolling
  if (!hasContent) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <EmptyState
          icon={Inbox}
          title="Your inbox is empty"
          description="Add a new reminder to get started"
          iconColor="primary"
          animationConfig={animationConfig}
        />
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
        <AnimatePresence mode="popLayout" initial={false}>
          {active.map((reminder, index) => (
            <motion.div
              key={reminder.id}
              initial={animationConfig.enabled ? CARD_ANIMATION.initial : false}
              animate={animationConfig.enabled ? CARD_ANIMATION.animate : { opacity: 1 }}
              exit={animationConfig.enabled ? CARD_ANIMATION.exit : undefined}
              style={{ marginBottom: '0.5rem' }}
            >
              {cardRenderer(reminder, index)}
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Completed section */}
        {completed.length > 0 && (
          <div className="mt-6 pb-4">
            <Divider className="mb-3" />
            {renderToggleButton ? (
              renderToggleButton({
                onPress: () => setShowCompleted(prev => !prev),
                showCompleted,
                count: completed.length
              })
            ) : (
              <Button
                variant="light"
                onPress={() => setShowCompleted(prev => !prev)}
                className="w-full justify-between h-10 px-0"
                endContent={
                  <motion.span
                    animate={{ rotate: showCompleted ? 180 : 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="inline-flex"
                  >
                    <ChevronDown size={18} />
                  </motion.span>
                }
              >
                <span
                  className="text-sm font-semibold text-default-600"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Completed ({completed.length})
                </span>
              </Button>
            )}

            <AnimatePresence mode="popLayout" initial={false}>
              {showCompleted && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{
                    opacity: 1,
                    height: 'auto',
                    transition: {
                      height: { type: 'spring', ...SPRING_CONFIG_BOUNCY },
                      opacity: { duration: 0.2, delay: 0.05 }
                    }
                  }}
                  exit={{
                    opacity: 0,
                    height: 0,
                    transition: {
                      height: { duration: 0.2 },
                      opacity: { duration: 0.15 }
                    }
                  }}
                  className="mt-3 overflow-hidden"
                >
                  <LayoutGroup>
                  <AnimatePresence mode="popLayout" initial={false}>
                    {completed.map((reminder, index) => (
                      <motion.div
                        key={reminder.id}
                        layout="position"
                        initial={animationConfig.enabled ? CARD_ANIMATION.initial : false}
                        animate={animationConfig.enabled ? {
                          ...CARD_ANIMATION.animate,
                          transition: {
                            ...CARD_ANIMATION.animate.transition,
                            delay: index * 0.03
                          }
                        } : { opacity: 1 }}
                        exit={animationConfig.enabled ? {
                          ...CARD_ANIMATION.exit,
                          x: 20 // Exit to right for completed items
                        } : undefined}
                        style={{ marginBottom: '0.5rem' }}
                      >
                        {cardRenderer(reminder, index)}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </LayoutGroup>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
});

export default InboxView;
