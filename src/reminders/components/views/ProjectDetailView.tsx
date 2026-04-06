import React, { useMemo, useState, useCallback, useEffect, useRef, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronDown, FolderOpen, Circle, CheckCircle2 } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import { ShadowDOMButton, ShadowDOMNativeButton } from '../ShadowDOMButton';
import type { Reminder } from '../../types/reminder';
import { sortRemindersByFileOrder } from '../../utils/reminderSort';
import { getProjectColor } from '../../utils/projectColors';
import { ReminderCard } from '../ReminderCard';
import { ReorderableReminderList } from '../ReorderableReminderList';
import { EmptyState } from '../EmptyState';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITH_FAB_CSS,
  CARD_ANIMATION,
} from '../../ui/layoutConstants';


export interface ProjectDetailViewProps {
  project: string;
  reminders: Reminder[];
  onBack: () => void;
  animationConfig?: AnimationConfig;
  /** Custom render function for reminder cards (for platform-specific wrappers) */
  renderCard?: (reminder: Reminder, index: number) => React.ReactNode;
  /** Whether to use fixed bottom padding (for views with FAB) */
  hasFab?: boolean;
  /** Custom class name for the container */
  className?: string;
  /** Callback when reminders are reordered via drag */
  onReorder?: (orderedIds: string[]) => void;
}


/**
 * Shared Project Detail view component
 * Displays reminders for a specific project with back navigation
 * Premium dark UI with glassmorphism and glow effects
 */
export const ProjectDetailView = memo(function ProjectDetailView({
  project,
  reminders,
  onBack,
  animationConfig = { enabled: true },
  renderCard,
  hasFab = true,
  className = '',
  onReorder,
}: ProjectDetailViewProps) {
  const [showCompleted, setShowCompleted] = useState(false);

  const { active, completed, accentColor, total, completionPercentage } = useMemo(() => {
    // Filter to only show reminders from this project
    const projectReminders = reminders.filter(r =>
      (r.project || 'Inbox') === project
    );

    const sorted = sortRemindersByFileOrder(projectReminders);
    const activeList = sorted.filter(r => !r.completed);
    const completedList = sorted.filter(r => r.completed);

    // Get project colors (using dark theme for premium UI)
    const colors = getProjectColor(project);
    const accent = colors.dark.accent;

    // Calculate completion percentage
    const totalCount = projectReminders.length;
    const percentage = totalCount > 0 ? Math.round((completedList.length / totalCount) * 100) : 0;

    return {
      active: activeList,
      completed: completedList,
      accentColor: accent,
      total: totalCount,
      completionPercentage: percentage
    };
  }, [reminders, project]);

  // Local state for optimistic reorder (visual only during drag)
  const [localOrder, setLocalOrder] = useState<Reminder[]>(active);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalOrder(active);
    }
  }, [active]);

  const handleDragActiveChange = useCallback((active: boolean) => {
    isDraggingRef.current = active;
  }, []);

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
      hideProject // Hide project tag since we're already in project view
    />
  );

  const cardRenderer = renderCard || defaultRenderCard;

  // Scroll container styles
  const scrollStyle: React.CSSProperties = {
    paddingLeft: `${CONTENT_PADDING_X}px`,
    paddingRight: `${CONTENT_PADDING_X}px`,
    paddingTop: `${CONTENT_PADDING_TOP}px`,
    paddingBottom: hasFab ? SCROLL_PADDING_WITH_FAB_CSS : '16px',
    touchAction: 'pan-y',
    willChange: 'transform',
  };

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Ghost back button */}
      <div>
        <ShadowDOMNativeButton
          onClick={onBack}
          className="premium-back-button"
        >
          <ChevronLeft size={14} />
          <span>Projects</span>
        </ShadowDOMNativeButton>
      </div>

      {/* Compact Project Header */}
      <div className="project-detail-header">
        <div className="project-detail-header-top">
          <h1 className="project-detail-title">{project}</h1>
          {total > 0 && (
            <span
              className="project-detail-percentage"
              style={{ color: completionPercentage === 100 ? '#22c55e' : accentColor }}
            >
              {completionPercentage}%
            </span>
          )}
        </div>
        {total > 0 && (
          <div className="project-detail-header-bottom">
            <div className="project-detail-stats-text">
              <span className="project-detail-stat">
                <Circle size={10} strokeWidth={2.5} />
                {active.length}
                <span className="project-detail-stat-label">active</span>
              </span>
              <span className="project-detail-stat-dot">&middot;</span>
              <span className="project-detail-stat project-detail-stat-done">
                <CheckCircle2 size={10} strokeWidth={2.5} />
                {completed.length}
                <span className="project-detail-stat-label">done</span>
              </span>
            </div>
            <div className="project-detail-progress-bar">
              <div
                className="project-detail-progress-fill"
                style={{
                  width: `${completionPercentage}%`,
                  backgroundColor: completionPercentage === 100 ? '#22c55e' : accentColor,
                  boxShadow: completionPercentage > 0
                    ? `0 0 4px ${completionPercentage === 100 ? '#22c55e' : accentColor}30`
                    : 'none',
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      {!hasContent ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={FolderOpen}
            title="No reminders"
            description="Add a reminder to this project"
            iconColor="primary"
            animationConfig={animationConfig}
          />
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-scroll ios-scroll"
          style={scrollStyle}
        >
          {/* Active reminders */}
          <ReorderableReminderList
            reminders={localOrder}
            onReorder={setLocalOrder}
            onReorderCommit={handleReorderCommit}
            onDragActiveChange={handleDragActiveChange}
            renderCard={cardRenderer}
          />

          {/* Completed section */}
          {completed.length > 0 && (
            <div className="mt-6 pb-4">
              <div className="premium-divider" />
              <ShadowDOMButton
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
                  className="text-sm font-semibold"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Completed ({completed.length})
                </span>
              </ShadowDOMButton>

              <AnimatePresence mode="popLayout" initial={false}>
                {showCompleted && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{
                      opacity: 1,
                      height: 'auto',
                      transition: {
                        height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
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
                      <AnimatePresence mode="popLayout" initial={false}>
                      {completed.map((reminder, index) => (
                        <motion.div
                          key={reminder.id}
                          initial={false}
                          animate={{ opacity: 1 }}
                          exit={{ ...CARD_ANIMATION.exit, x: 20 }}
                          className="premium-reminder-card-wrapper"
                        >
                          {cardRenderer(reminder, index)}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default ProjectDetailView;
