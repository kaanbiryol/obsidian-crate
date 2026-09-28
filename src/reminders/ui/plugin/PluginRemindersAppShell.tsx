import { AppDock, DockAddButton } from '@/ui/shared/navigation/AppDock';
import { DOCK_TABS } from '@/ui/shared/navigation/dock-destinations';
import { ScheduleSwitcher } from '@/ui/shared/navigation/ScheduleSwitcher';
import { TabTransition } from '@/ui/shared/navigation/TabTransition';
import { NavigationScreen } from '@/ui/shared/navigation/NavigationScreen';
import { PWA_CONTROL_SPRING } from '@/ui/shared/navigation/motion';
import { BackButton } from '@/ui/shared/BackButton';
import { ProjectDetailView } from '../views';
import type { TabId } from '../layoutConstants';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";

import { ThemeIcon } from "@/reminders/components/theme-icon";

import { ShadowDOMButton } from "@/reminders/components/ShadowDOMButton";
import { ViewHeader } from "@/reminders/components/ViewHeader";
import type { Reminder } from "@/reminders/types/reminder";
import { RemindersViewPanels } from "@/reminders/ui/RemindersViewPanels";
import { useObsidianReducedMotion } from "@/reminders/ui/useObsidianReducedMotion";
import { useReminderClock } from '../useReminderClock';
import {
  getCurrentHeaderData,
  getReminderCreateProject,
  getReminderProjects,
  getRemindersHeaderData,
  getReorderProject,
  shouldShowReminderFab,
  type ViewMode,
} from "@/reminders/ui/remindersViewModel";

export type PluginReminderCardRenderer = (props: {
  reminder: Reminder;
  index: number;
  hideProject: boolean;
}) => React.ReactNode;

interface PluginRemindersAppShellProps {
  reminders: Reminder[];
  projects?: string[];
  isInitialLoadComplete: boolean;
  isDarkMode: boolean;
  isFullScreen?: boolean;
  isModal?: boolean;
  isCompact?: boolean;
  initialTab?: TabId;
  initialProject?: string;
  hideTabBar?: boolean;
  upcomingDays: number;
  loadingContent?: React.ReactNode;
  activeTab?: TabId;
  onTabChange?: (tab: TabId) => void;
  renderNavigation?: (tab: TabId, onChange: (tab: TabId) => void, onAdd: (() => void) | undefined, inert: boolean) => React.ReactNode;
  headerRightContent?: React.ReactNode;
  renderHeader?: (title: string, actions: React.ReactNode) => React.ReactNode;
  belowHeaderContent?: React.ReactNode;
  topOverlay?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  suppressFab?: boolean;
  renderCard: PluginReminderCardRenderer;
  onAdd: (defaultProject: string) => void;
  onReorder: (project: string, orderedIds: string[]) => Promise<void> | void;
  onReorderDragActiveChange?: (active: boolean) => void;
  reorderInteraction?: 'drag' | 'long-press';
}

/** Local navigation state with the same dock, date switcher and transitions as the PWA. */
export const PluginRemindersAppShell: React.FC<PluginRemindersAppShellProps> = ({
  reminders,
  projects: providedProjects,
  isInitialLoadComplete,
  isDarkMode,
  isFullScreen = false,
  isModal = false,
  isCompact = false,
  initialTab,
  initialProject,
  hideTabBar = false,
  upcomingDays,
  loadingContent,
  activeTab,
  onTabChange,
  renderNavigation,
  headerRightContent,
  renderHeader,
  belowHeaderContent,
  topOverlay,
  children,
  className = "",
  suppressFab = false,
  renderCard,
  onAdd,
  onReorder,
  onReorderDragActiveChange,
  reorderInteraction = 'drag',
}) => {
  const [localViewMode, setLocalViewMode] = useState<ViewMode>(initialProject ? "browse" : (initialTab ?? "inbox"));
  const [selectedProject, setSelectedProject] = useState<string | null>(initialProject ?? null);
  const [closingProject, setClosingProject] = useState(false);
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);
  const shell = useRef<HTMLDivElement>(null);
  const lastProject = useRef(initialProject);
  const restoreProjectFocus = useRef(false);
  const prefersReducedMotion = useObsidianReducedMotion();
  const viewMode = activeTab ?? localViewMode;
  const setViewMode = useCallback((tab: TabId) => {
    setLocalViewMode(tab);
    onTabChange?.(tab);
  }, [onTabChange]);
  const projects = useMemo(() => providedProjects ?? getReminderProjects(reminders), [providedProjects, reminders]);
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    setSelectedProject(null);
  }, [setViewMode]);
  const handleProjectSelect = useCallback((project: string) => {
    lastProject.current = project;
    setDirection(1);
    setSelectedProject(project);
  }, []);
  const handleBackToProjects = useCallback(() => {
    restoreProjectFocus.current = true;
    setDirection(-1);
    setClosingProject(true);
    setSelectedProject(null);
  }, []);
  const finishProjectClose = () => setClosingProject(false);
  useLayoutEffect(() => {
    if (selectedProject || closingProject || !restoreProjectFocus.current) return;
    restoreProjectFocus.current = false;
    const button = Array.from(shell.current?.querySelectorAll<HTMLElement>('[data-action="open-project"]') ?? [])
      .find(candidate => candidate.dataset.project === lastProject.current);
    button?.focus({ preventScroll: true });
  }, [selectedProject, closingProject]);

  const clock = useReminderClock(reminders);
  const headerData = useMemo(() => {
    return getRemindersHeaderData(reminders, projects, upcomingDays, clock.now);
  }, [reminders, projects, upcomingDays, clock]);

  const currentHeader = useMemo(() => {
    return getCurrentHeaderData(viewMode, headerData);
  }, [headerData, viewMode]);

  const showFab = shouldShowReminderFab(viewMode, selectedProject);
  const primaryTab = viewMode === 'upcoming' ? 'today' : viewMode;
  const rootCovered = Boolean(selectedProject) || closingProject;

  const handleAdd = useCallback(() => {
    onAdd(getReminderCreateProject(viewMode, selectedProject));
  }, [onAdd, selectedProject, viewMode]);

  const panelCardRenderer = useCallback((reminder: Reminder, index: number) => {
    return renderCard({
      reminder,
      index,
      hideProject: viewMode === "browse" && selectedProject !== null,
    });
  }, [renderCard, selectedProject, viewMode]);

  const renderToggleButton = useCallback(({ onPress, showCompleted, count }: {
    onPress: () => void;
    showCompleted: boolean;
    count: number;
  }) => (
    <ShadowDOMButton
      variant="light"
      onPress={onPress}
      className="completed-section-toggle w-full justify-between h-10 px-0"
      endContent={
        <motion.span
          animate={{ rotate: showCompleted ? 180 : 0 }}
          transition={prefersReducedMotion ? { duration: 0 } : PWA_CONTROL_SPRING}
          className="inline-flex"
        >
          <ThemeIcon size="m" id="chevron-down" />
        </motion.span>
      }
    >
      <span className="reminders-muted-label">
        Completed ({count})
      </span>
    </ShadowDOMButton>
  ), [prefersReducedMotion]);

  const currentProject = getReorderProject(viewMode, selectedProject);

  const handleReorder = useCallback((orderedIds: string[]) => {
    if (!currentProject) return;
    return onReorder(currentProject, orderedIds);
  }, [currentProject, onReorder]);

  const viewPanels = (
    <RemindersViewPanels
      viewMode={viewMode}
      selectedProject={null}
      isInitialLoadComplete={isInitialLoadComplete}
      reminders={reminders}
      projects={projects}
      showFab={!suppressFab}
      upcomingDays={upcomingDays}
      renderCard={(reminder, index) => renderCard({ reminder, index, hideProject: false })}
      renderToggleButton={renderToggleButton}
      onProjectSelect={handleProjectSelect}
      onBackToProjects={handleBackToProjects}
      onReorder={handleReorder}
      onReorderDragActiveChange={onReorderDragActiveChange}
      colorScheme={isDarkMode ? 'dark' : 'light'}
      reorderInteraction={reorderInteraction}
      pageTransitionsEnabled={false}
      animationsEnabled={!prefersReducedMotion}
    />
  );
  const add = !loadingContent && !suppressFab ? handleAdd : undefined;
  return <MotionConfig reducedMotion={prefersReducedMotion ? 'always' : 'user'}>
    <div ref={shell} className={[
      'reminders-view is-primary plugin-reminders-navigation',
      isDarkMode ? 'dark' : 'light', isFullScreen ? 'is-fullscreen' : '',
      isModal ? 'is-modal' : '', isCompact || hideTabBar ? 'is-compact' : '',
      prefersReducedMotion ? 'is-reduced-motion' : '',
      selectedProject ? 'is-project-detail' : `is-${viewMode}`, className,
    ].filter(Boolean).join(' ')}>
      {renderHeader?.(selectedProject ?? currentHeader.title, headerRightContent)}
      {topOverlay}
      <div className="plugin-reminders-body">
      <div className="pwa-navigation-viewport" inert={rootCovered} aria-hidden={rootCovered || undefined}>
        <TabTransition viewKey={primaryTab}>
          {!renderHeader && <ViewHeader {...currentHeader} title={primaryTab === 'today' ? 'Reminders' : currentHeader.title}
            countUnit={viewMode === 'browse' ? 'project' : 'reminder'} large={isFullScreen}
            showMeta={isInitialLoadComplete && !loadingContent} rightContent={headerRightContent} />}
          {(viewMode === 'today' || viewMode === 'upcoming') && <ScheduleSwitcher value={viewMode} onChange={handleViewModeChange} />}
          {belowHeaderContent}
          <div className="reminders-content">
            {loadingContent ?? (primaryTab === 'today' ? <TabTransition viewKey={viewMode}>{viewPanels}</TabTransition> : viewPanels)}
          </div>
        </TabTransition>
      </div>
      {!hideTabBar && (renderNavigation?.(viewMode, handleViewModeChange, add, rootCovered)
        ?? <AppDock section="reminders" tabs={['inbox', 'today', 'browse']} destinations={DOCK_TABS.filter(item => ['inbox', 'today', 'browse'].includes(item.id))}
          activeTab={primaryTab} onSelect={tab => handleViewModeChange(tab as TabId)} onPin={tab => handleViewModeChange(tab as TabId)} onAdd={add} inert={rootCovered} />)}
      <div className="pwa-project-layer" data-project-open={rootCovered}>
        <AnimatePresence initial={false} custom={{ direction, reduceMotion: prefersReducedMotion }} onExitComplete={finishProjectClose}>
          {selectedProject && <NavigationScreen key={selectedProject} motion={{ direction, reduceMotion: prefersReducedMotion }} isProjectDetail>
            <div className="reminders-content">
              <ProjectDetailView project={selectedProject} hideTitle={Boolean(renderHeader)}
                backControl={<BackButton label="Back to projects" onClick={handleBackToProjects} />}
                navigationRightContent={renderHeader ? undefined : headerRightContent} belowHeaderContent={belowHeaderContent}
                reminders={reminders} loadingContent={loadingContent} onBack={handleBackToProjects}
                animationConfig={{ enabled: !prefersReducedMotion }} renderCard={panelCardRenderer}
                hasFab={showFab && !suppressFab} onReorder={handleReorder} onReorderDragActiveChange={onReorderDragActiveChange}
                colorScheme={isDarkMode ? 'dark' : 'light'} reorderInteraction={reorderInteraction} />
            </div>
            {add && <div className="pwa-dock pwa-project-dock"><DockAddButton section="reminders" onClick={add} /></div>}
          </NavigationScreen>}
        </AnimatePresence>
      </div>
      </div>
      {children}
    </div>
  </MotionConfig>;
};
