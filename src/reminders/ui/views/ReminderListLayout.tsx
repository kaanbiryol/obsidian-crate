import React, { forwardRef, useCallback, useId, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useIsPresent, type HTMLMotionProps } from 'motion/react';
import type { Reminder } from '../../types/reminder';
import type { AnimationConfig } from '../../types/componentAdapter';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { REMINDER_LIST_FADE_TRANSITION } from '../layoutConstants';
import { useStableReminderScroll } from '../hooks/useStableReminderScroll';
import { CompletedReminderSection, type CompletedSectionToggleProps } from './CompletedReminderSection';

// Pop the departing state out of flow without changing the scroller's parent.
// Incoming content mounts immediately; outgoing controls cannot receive input.
const ListState = forwardRef<HTMLDivElement, HTMLMotionProps<'div'>>(function ListState(props, ref) {
  const present = useIsPresent();
  return <motion.div {...props} ref={ref} inert={!present} aria-hidden={!present}
    style={{ pointerEvents: present ? 'auto' : 'none' }} />;
});

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
  const [presenceRoot, setPresenceRoot] = useState<ShadowRoot>();
  const captureRoot = useCallback((element: HTMLDivElement | null) => {
    const root = element?.getRootNode();
    // Motion's pop-layout stylesheet must live alongside the animated nodes.
    setPresenceRoot(root && 'host' in root ? root as ShadowRoot : undefined);
  }, []);

  return (
    <div ref={captureRoot} className={`flex flex-col h-full relative min-h-0 ${className}`}>
      {header}
      <AnimatePresence initial={false} mode="popLayout" root={presenceRoot}>
        {hasContent ? (
          <ListState
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
          </ListState>
        ) : (
          <ListState
            key="empty-state"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition}
            className="reminders-empty-body flex-1 flex items-center justify-center"
          >{emptyState}</ListState>
        )}
      </AnimatePresence>
    </div>
  );
}
