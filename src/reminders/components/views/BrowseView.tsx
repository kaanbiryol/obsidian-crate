import React, { memo, useMemo } from 'react';
import { FolderOpen } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { EmptyState } from '../EmptyState';
import { BrowseProjectCard } from './BrowseProjectCard';
import { buildBrowseProjectCardsViewModel, type ProjectStats } from './viewModels';
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
  const cards = useMemo(() => buildBrowseProjectCardsViewModel(projects, reminders), [projects, reminders]);

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
          {cards.map((card) => (
            <BrowseProjectCard
              key={card.project}
              card={card}
              onClick={() => onProjectSelect(card.project)}
              animationConfig={animationConfig}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

export default BrowseView;
