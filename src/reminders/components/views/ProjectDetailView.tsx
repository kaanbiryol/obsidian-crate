import React, { useMemo, useState, memo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronDown, FolderOpen, Circle, CheckCircle2, Check } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import { ShadowDOMButton, ShadowDOMNativeButton } from '../ShadowDOMButton';
import type { Reminder } from '../../types/reminder';
import { sortReminders } from '../../utils/reminderSort';
import { getProjectColor } from '../../utils/projectColors';
import { ReminderCard } from '../ReminderCard';
import { EmptyState } from '../EmptyState';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITH_FAB_CSS,
  CARD_ANIMATION,
} from '../../ui/layoutConstants';
import { softRadialGlow } from '../../ui/gradients';

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
}


/**
 * Premium Ring Progress Component with glow effect
 */
interface RingProgressProps {
  percentage: number;
  accentColor: string;
  size?: number;
}

const RingProgress = memo(function RingProgress({
  percentage,
  accentColor,
  size = 100
}: RingProgressProps) {
  const [animatedOffset, setAnimatedOffset] = useState(264); // Full circumference (no fill)
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const targetOffset = circumference - (percentage / 100) * circumference;
  const isComplete = percentage === 100;

  // Animate the ring on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      setAnimatedOffset(targetOffset);
    }, 200);
    return () => clearTimeout(timer);
  }, [targetOffset]);

  return (
    <div className="premium-ring-container" style={{ width: size, height: size }}>
      {/* Glow backdrop */}
      <div
        className="premium-ring-glow"
        style={{
          ['--reminders-glow' as string]: softRadialGlow(accentColor, { shape: 'circle', strength: 0.1 }),
        } as React.CSSProperties}
      />

      {/* SVG Ring */}
      <svg
        viewBox="0 0 100 100"
        className="premium-ring-svg"
        style={{ width: size, height: size }}
      >
        {/* Track */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="4"
        />
        {/* Progress */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={isComplete ? '#22c55e' : accentColor}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={animatedOffset}
          className="premium-ring-progress"
          style={{
            filter: `drop-shadow(0 0 3px ${isComplete ? '#22c55e' : accentColor})`,
            transform: 'rotate(-90deg)',
            transformOrigin: '50% 50%',
            transition: 'stroke-dashoffset 800ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      </svg>

      {/* Center content */}
      <div className="premium-ring-center">
        {isComplete ? (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.6, duration: 0.3, ease: 'easeOut' }}
          >
            <Check size={28} strokeWidth={3} style={{ color: '#22c55e' }} />
          </motion.div>
        ) : (
          <span className="premium-ring-percentage">{percentage}%</span>
        )}
      </div>
    </div>
  );
});

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
  className = ''
}: ProjectDetailViewProps) {
  const [showCompleted, setShowCompleted] = useState(false);

  const { active, completed, accentColor, total, completionPercentage } = useMemo(() => {
    // Filter to only show reminders from this project
    const projectReminders = reminders.filter(r =>
      (r.project || 'Inbox') === project
    );

    // Sort and split
    const sorted = sortReminders(projectReminders);
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

      {/* Premium Hero Header Card */}
      <div className="premium-hero-card">
        {/* Glow backdrop */}
        <div
          className="premium-hero-glow"
          style={{
            ['--reminders-glow' as string]: softRadialGlow(accentColor, { shape: 'ellipse', strength: 0.08 }),
          } as React.CSSProperties}
        />

        {/* Glass content */}
        <div className="premium-hero-content">
          {/* Left: Title */}
          <div className="premium-hero-info">
            <h1 className="premium-hero-title">{project}</h1>
          </div>

          {/* Right: Ring Progress */}
          {total > 0 && (
            <div className="premium-hero-progress">
              <RingProgress
                percentage={completionPercentage}
                accentColor={accentColor}
                size={72}
              />
            </div>
          )}
        </div>

        {/* Stat Pills */}
        {total > 0 && (
          <div className="premium-stats-row">
            {/* Active Pill */}
            <div className="premium-stat-pill">
              <div className="premium-stat-icon">
                <Circle size={14} strokeWidth={2.5} />
              </div>
              <div className="premium-stat-content">
                <span className="premium-stat-number">{active.length}</span>
                <span className="premium-stat-label">ACTIVE</span>
              </div>
            </div>

            {/* Done Pill */}
            <div className="premium-stat-pill premium-stat-pill-success">
              <div className="premium-stat-icon" style={{ color: '#22c55e' }}>
                <CheckCircle2 size={14} strokeWidth={2.5} />
              </div>
              <div className="premium-stat-content">
                <span className="premium-stat-number">{completed.length}</span>
                <span className="premium-stat-label">DONE</span>
              </div>
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
          <AnimatePresence mode="popLayout" initial={false}>
            {active.map((reminder, index) => (
              <motion.div
                key={reminder.id}
                initial={false}
                animate={{ opacity: 1 }}
                exit={CARD_ANIMATION.exit}
                className="premium-reminder-card-wrapper"
              >
                {cardRenderer(reminder, index)}
              </motion.div>
            ))}
          </AnimatePresence>

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
