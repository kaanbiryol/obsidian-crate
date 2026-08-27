import React, { useMemo, useState, useCallback, useEffect, useRef, memo } from 'react';
import { LayoutGroup } from 'framer-motion';
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
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useStableReminderScroll } from '../hooks/useStableReminderScroll';


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
  onReorderDragActiveChange?: (active: boolean) => void;
  reorderInteraction?: 'handle' | 'long-press';
  colorScheme?: ProjectColorScheme;
}


/**
 * Shared Project Detail view component
 * Displays reminders for a specific project with back navigation
 * Uses host-theme surfaces with a theme-adjusted project accent.
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
  onReorderDragActiveChange,
  reorderInteraction = 'handle',
  colorScheme = 'dark',
}: ProjectDetailViewProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  const scrollRef = useStableReminderScroll();

  const detail = useMemo(() => {
    return buildProjectDetailViewModel(reminders, project, colorScheme);
  }, [colorScheme, reminders, project]);
  const header = useMemo(
    () => buildProjectDetailHeaderViewModel(reminders, project, colorScheme),
    [colorScheme, reminders, project],
  );
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
    onReorderDragActiveChange?.(active);
  }, [onReorderDragActiveChange]);

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
      colorScheme={colorScheme}
    />
  );

  const cardRenderer = renderCard || defaultRenderCard;

  return (
    <div className={`project-detail-shell flex flex-col h-full ${className}`}>
      <div className="project-detail-toolbar">
        <ShadowDOMNativeButton
          onClick={onBack}
          className="premium-back-button"
          aria-label="Back to projects"
        >
          <ChevronLeft size={17} />
        </ShadowDOMNativeButton>

        <ProjectDetailHeader project={project} header={header} />
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
          ref={scrollRef}
          className={`flex-1 overflow-y-scroll ios-scroll reminders-view-scroll will-change-transform${hasFab ? ' has-fab' : ''}`}
        >
          <LayoutGroup id={`project-${project}-reminder-sections`}>
            {/* Active reminders */}
            <ReorderableReminderList
              reminders={localOrder}
              onReorder={setLocalOrder}
              onReorderCommit={handleReorderCommit}
              onDragActiveChange={handleDragActiveChange}
              renderCard={cardRenderer}
              interaction={reorderInteraction}
            />

            <ProjectCompletedSection
              reminders={completed}
              showCompleted={showCompleted}
              onToggle={() => setShowCompleted((prev) => !prev)}
              renderCard={cardRenderer}
            />
          </LayoutGroup>
        </div>
      )}
    </div>
  );
});
