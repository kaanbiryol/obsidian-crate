import React, { memo, useMemo } from 'react';
import { FolderOpen, ChevronRight, Circle, CheckCircle2, Sparkles } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import { ShadowDOMNativeMotionButton } from '../ShadowDOMButton';
import type { Reminder } from '../../types/reminder';
import { getProjectColor } from '../../utils/projectColors';
import { EmptyState } from '../EmptyState';
import { buildProjectStatsMap, getProjectStats, type ProjectStats } from './viewModels';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITHOUT_FAB_CSS
} from '../../ui/layoutConstants';

export interface BrowseViewProps {
  projects: string[];
  reminders: Reminder[];
  onProjectSelect: (project: string) => void;
  animationConfig?: AnimationConfig;
  /** Optional header content to display */
  headerContent?: React.ReactNode;
  /** Show the header section */
  showHeader?: boolean;
  /** Custom class name for the container */
  className?: string;
}

export type { ProjectStats } from './viewModels';

/**
 * Mini progress bar component
 */
const MiniProgressBar = memo(function MiniProgressBar({
  percentage,
  accentColor,
  isComplete
}: {
  percentage: number;
  accentColor: string;
  isComplete: boolean;
}) {
  return (
    <div className="premium-mini-progress">
      <div
        className="premium-mini-progress-fill"
        style={{
          width: `${percentage}%`,
          backgroundColor: isComplete ? '#22c55e' : accentColor,
          boxShadow: percentage > 0 ? `0 0 4px ${isComplete ? '#22c55e' : accentColor}30` : 'none',
        }}
      />
    </div>
  );
});

/**
 * Premium Project Card Component
 */
const ProjectCard = memo(function ProjectCard({
  project,
  stats,
  accentColor,
  onClick,
  index,
  animationConfig
}: {
  project: string;
  stats: ProjectStats;
  accentColor: string;
  onClick: () => void;
  index: number;
  animationConfig: AnimationConfig;
}) {
  const isComplete = stats.total > 0 && stats.active === 0;

  return (
    <ShadowDOMNativeMotionButton
      onClick={onClick}
      className="premium-project-card"
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0 }}
      whileTap={{ scale: 0.98 }}
    >
      {/* Card content */}
      <div className="premium-project-content">
        {/* Left section: Accent + Info */}
        <div className="premium-project-left">
          {/* Accent bar with glow */}
          <div className="premium-project-accent-wrapper">
            <div
              className="premium-project-accent"
              style={{
                backgroundColor: accentColor,
                boxShadow: `0 0 6px ${accentColor}40`,
              }}
            />
          </div>

          {/* Project info */}
          <div className="premium-project-info">
            <div className="premium-project-name">{project}</div>

            {/* Stats row */}
            <div className="premium-project-stats">
              {stats.total === 0 ? (
                <span className="premium-project-stat-empty">No reminders</span>
              ) : isComplete ? (
                <span className="premium-project-stat-complete">
                  <Sparkles size={12} />
                  All done
                </span>
              ) : (
                <>
                  <span className="premium-project-stat">
                    <Circle size={10} strokeWidth={2.5} />
                    {stats.active}
                  </span>
                  {stats.completed > 0 && (
                    <span className="premium-project-stat premium-project-stat-done">
                      <CheckCircle2 size={10} strokeWidth={2.5} />
                      {stats.completed}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right section: Progress + Chevron */}
        <div className="premium-project-right">
          {/* Progress indicator */}
          {stats.total > 0 && (
            <div className="premium-project-progress">
              <MiniProgressBar
                percentage={stats.completionPercentage}
                accentColor={accentColor}
                isComplete={isComplete}
              />
              <span className="premium-project-percentage">
                {stats.completionPercentage}%
              </span>
            </div>
          )}

          {/* Chevron */}
          <ChevronRight
            size={16}
            className="premium-project-chevron"
            strokeWidth={2}
          />
        </div>
      </div>
    </ShadowDOMNativeMotionButton>
  );
});

/**
 * Shared Browse view component
 * Premium dark glassmorphism design - displays projects as elegant glass cards
 */
export const BrowseView = memo(function BrowseView({
  projects,
  reminders,
  onProjectSelect,
  animationConfig = { enabled: true },
  headerContent,
  showHeader = false,
  className = ''
}: BrowseViewProps) {
  const projectStatsMap = useMemo(() => buildProjectStatsMap(reminders), [reminders]);

  // Empty state
  if (projects.length === 0) {
    return (
      <div className={`flex flex-col h-full ${className}`}>
        {showHeader && headerContent}
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={FolderOpen}
            title="No projects yet"
            description="Add a reminder to create your first project"
            iconColor="primary"
            animationConfig={animationConfig}
          />
        </div>
      </div>
    );
  }

  // Scroll container styles
  const scrollStyle: React.CSSProperties = {
    paddingLeft: `${CONTENT_PADDING_X}px`,
    paddingRight: `${CONTENT_PADDING_X}px`,
    paddingTop: `${CONTENT_PADDING_TOP}px`,
    paddingBottom: SCROLL_PADDING_WITHOUT_FAB_CSS,
    touchAction: 'pan-y'
  };

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {showHeader && headerContent}

      <div
        className="flex-1 overflow-y-scroll ios-scroll"
        style={scrollStyle}
      >
        {/* Projects list */}
        <div className="premium-projects-list">
          {projects.map((project, index) => {
            const stats = getProjectStats(projectStatsMap, project);
            const projectColors = getProjectColor(project);
            const accentColor = projectColors.dark.accent;

            return (
              <ProjectCard
                key={project}
                project={project}
                stats={stats}
                accentColor={accentColor}
                onClick={() => onProjectSelect(project)}
                index={index}
                animationConfig={animationConfig}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default BrowseView;
