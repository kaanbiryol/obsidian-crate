import React, { useMemo, memo } from 'react';

import { ReminderListLayout } from './ReminderListLayout';

import type { AnimationConfig } from '../../types/componentAdapter';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import type { Reminder } from '../../types/reminder';
import { ReminderCard } from '../../components/ReminderCard';
import { ReorderableReminderList } from '../../components/ReorderableReminderList';
import { EmptyState } from '../../components/EmptyState';
import { ProjectDetailHeader } from './ProjectDetailHeader';
import { buildProjectDetailHeaderViewModel, buildProjectDetailViewModel } from './viewModels';
import type { ProjectColorScheme } from '../../utils/projectColors';
import { useReminderOrder } from '../hooks/useReminderOrder';
import { ThemeIcon } from '../../components/theme-icon';


export interface ProjectDetailViewProps {
  project: string;
  hideTitle?: boolean;
  headerRightContent?: React.ReactNode;
  headerMetaContent?: React.ReactNode;
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
  onReorder?: (orderedIds: string[]) => Promise<void> | void;
  onReorderDragActiveChange?: (active: boolean) => void;
  reorderInteraction?: 'drag' | 'long-press';
  colorScheme?: ProjectColorScheme;
}


/**
 * Shared Project Detail view component
 * Displays reminders for a specific project with back navigation
 * Uses host-theme surfaces with a theme-adjusted project accent.
 */
export const ProjectDetailView = memo(function ProjectDetailView({
  project,
  hideTitle = false,
  headerRightContent,
  headerMetaContent,
  reminders,
  onBack,
  animationConfig = { enabled: true },
  renderCard,
  hasFab = true,
  className = '',
  onReorder,
  onReorderDragActiveChange,
  reorderInteraction = 'drag',
  colorScheme = 'dark',
}: ProjectDetailViewProps) {
  const detail = useMemo(() => {
    return buildProjectDetailViewModel(reminders, project, colorScheme);
  }, [colorScheme, reminders, project]);
  const header = useMemo(
    () => buildProjectDetailHeaderViewModel(reminders, project, colorScheme),
    [colorScheme, reminders, project],
  );
  const { active, completed } = detail;

  const order = useReminderOrder(active, onReorder, onReorderDragActiveChange);

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
    <ReminderListLayout
      className={className}
      hasFab={hasFab}
      hasContent={hasContent}
      renderCard={cardRenderer}
      animationConfig={animationConfig}
      completed={completed}
      isDragging={order.isDragging}
      header={
        <>
          <div>
            <ShadowDOMNativeButton onClick={onBack} className="premium-back-button">
              <ThemeIcon size="xs" id="chevron-left" />
              <span>Projects</span>
            </ShadowDOMNativeButton>
          </div>
          <ProjectDetailHeader project={project} header={header} hideTitle={hideTitle} rightContent={headerRightContent} metaContent={headerMetaContent} />
        </>
      }
      emptyState={
        <EmptyState
          icon="folder-open"
          title="No reminders"
          description="Add a reminder to this project"
          iconColor="primary"
          animationConfig={animationConfig}
        />
      }
    >
      <ReorderableReminderList
        reminders={order.displayedOrder}
        onReorder={order.onReorder}
        onReorderCommit={order.onCommit}
        onDragActiveChange={order.onDragChange}
        renderCard={cardRenderer}
        interaction={reorderInteraction}
        animationsEnabled={animationConfig.enabled}
      />
    </ReminderListLayout>
  );
});
