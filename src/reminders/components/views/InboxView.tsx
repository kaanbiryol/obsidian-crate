import React, { useMemo, useState, useCallback, useEffect, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Inbox, ChevronDown } from 'lucide-react';
import { Button, Divider } from '@heroui/react';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ReminderCard } from '../ReminderCard';
import { ReorderableReminderList } from '../ReorderableReminderList';
import { EmptyState } from '../EmptyState';
import { buildInboxViewModel } from './viewModels';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITH_FAB_CSS,
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
  /** Callback when reminders are reordered via drag */
  onReorder?: (orderedIds: string[]) => void;
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
}: InboxViewProps) {
  const [showCompleted, setShowCompleted] = useState(false);

  const { active, completed } = useMemo(() => buildInboxViewModel(reminders), [reminders]);

  // Local state for optimistic reorder (visual only during drag)
  const [localOrder, setLocalOrder] = useState<Reminder[]>(active);

  useEffect(() => {
    setLocalOrder(active);
  }, [active]);

  const handleReorderCommit = useCallback((orderedIds: string[]) => {
    onReorder?.(orderedIds);
  }, [onReorder]);

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
        <ReorderableReminderList
          reminders={localOrder}
          onReorder={setLocalOrder}
          onReorderCommit={handleReorderCommit}
          renderCard={cardRenderer}
        />

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
                        initial={animationConfig.enabled ? { opacity: 0, y: 6 } : false}
                        animate={animationConfig.enabled ? {
                          opacity: 1,
                          y: 0,
                          transition: {
                            duration: 0.4,
                            delay: index * 0.03,
                            ease: [0.4, 0, 0.2, 1] as const
                          }
                        } : { opacity: 1 }}
                        exit={animationConfig.enabled ? {
                          opacity: 0,
                          x: 20,
                          transition: { duration: 0.25, ease: [0.4, 0, 1, 1] as const }
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
