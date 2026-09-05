import React, { memo, useMemo } from 'react';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { EmptyState } from '../../components/EmptyState';
import { buildProjectTree, ProjectTree } from './ProjectTree';
import { buildBrowseProjectCardsViewModel } from './viewModels';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

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
  colorScheme?: ProjectColorScheme;
}

/**
 * Shared Browse view component
 * Displays projects using host-theme surfaces and curated project accents.
 */
export const BrowseView = memo(function BrowseView({
  projects,
  reminders,
  onProjectSelect,
  animationConfig = { enabled: true },
  headerContent,
  showHeader = false,
  className = '',
  colorScheme = 'dark',
}: BrowseViewProps) {
  const reduceMotion = useObsidianReducedMotion();
  const animationsEnabled = animationConfig.enabled && !reduceMotion;
  const effectiveAnimationConfig = { ...animationConfig, enabled: animationsEnabled };
  const cards = useMemo(
    () => buildBrowseProjectCardsViewModel(projects, reminders, colorScheme),
    [colorScheme, projects, reminders],
  );

  const tree = useMemo(() => buildProjectTree(cards), [cards]);

  // Empty state
  if (projects.length === 0) {
    return (
      <div className={`flex flex-col h-full ${className}`}>
        {showHeader && headerContent}
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon="folder-open"
            title="No projects yet"
            description="Add a reminder to create your first project"
            iconColor="primary"
            animationConfig={effectiveAnimationConfig}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {showHeader && headerContent}

      <div
        className="flex-1 overflow-y-scroll ios-scroll reminders-view-scroll is-tab-aware"
      >
        {/* Projects list */}
        <div className="premium-projects-list">
          <ProjectTree nodes={tree} onProjectSelect={onProjectSelect} />
        </div>
      </div>
    </div>
  );
});
