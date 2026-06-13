import React, { useMemo, useState, useCallback, useEffect, useRef, memo } from 'react';
import { ChevronLeft, FolderOpen } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';
import type { Reminder } from '../../types/reminder';
import { ReminderCard } from '../../components/ReminderCard';
import { ReorderableReminderList } from '../../components/ReorderableReminderList';
import { EmptyState } from '../../components/EmptyState';
import { ProjectCompletedSection } from './ProjectCompletedSection';
import { ProjectDetailHeader } from './ProjectDetailHeader';
import { buildProjectDetailHeaderViewModel, buildProjectDetailViewModel } from './viewModels';
import {
  CONTENT_PADDING_X,
  CONTENT_PADDING_TOP,
  SCROLL_PADDING_WITH_FAB_CSS,
} from '../layoutConstants';


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

  const detail = useMemo(() => {
    return buildProjectDetailViewModel(reminders, project);
  }, [reminders, project]);
  const header = useMemo(() => buildProjectDetailHeaderViewModel(reminders, project), [reminders, project]);
  const { active, completed } = detail;

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

      <ProjectDetailHeader project={project} header={header} />

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

          <ProjectCompletedSection
            reminders={completed}
            showCompleted={showCompleted}
            onToggle={() => setShowCompleted((prev) => !prev)}
            renderCard={cardRenderer}
          />
        </div>
      )}
    </div>
  );
});
