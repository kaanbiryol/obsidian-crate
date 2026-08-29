import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { HeroUIProvider } from "@heroui/react";

import { BottomTabBar } from "@/reminders/components/BottomTabBar";
import { FloatingActionButton } from "@/reminders/components/FloatingActionButton";
import { ShadowDOMButton } from "@/reminders/components/ShadowDOMButton";
import { ViewHeader } from "@/reminders/components/ViewHeader";
import type { Reminder } from "@/reminders/types/reminder";
import {
  PAGE_TRANSITION_DURATION,
  type TabId,
} from "@/reminders/ui/layoutConstants";
import { RemindersViewPanels } from "@/reminders/ui/RemindersViewPanels";
import {
  getCurrentHeaderData,
  getReminderCreateProject,
  getReminderProjects,
  getRemindersHeaderData,
  getReorderProject,
  shouldShowReminderFab,
  type ViewMode,
} from "@/reminders/ui/remindersViewModel";

export type ReminderCardRenderer = (props: {
  reminder: Reminder;
  index: number;
  hideProject: boolean;
}) => React.ReactNode;

interface RemindersAppShellProps {
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
  loadingTransition?: boolean;
  headerRightContent?: React.ReactNode;
  belowHeaderContent?: React.ReactNode;
  topOverlay?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  suppressFab?: boolean;
  renderCard: ReminderCardRenderer;
  onAdd: (defaultProject: string) => void;
  onReorder: (project: string, orderedIds: string[]) => Promise<void> | void;
  onReorderDragActiveChange?: (active: boolean) => void;
  reorderInteraction?: 'handle' | 'long-press';
}

export const RemindersAppShell: React.FC<RemindersAppShellProps> = ({
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
  loadingTransition = false,
  headerRightContent,
  belowHeaderContent,
  topOverlay,
  children,
  className = "",
  suppressFab = false,
  renderCard,
  onAdd,
  onReorder,
  onReorderDragActiveChange,
  reorderInteraction = 'handle',
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>(initialProject ? "browse" : (initialTab ?? "inbox"));
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(initialProject ?? null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  const projects = useMemo(() => {
    return providedProjects ?? getReminderProjects(reminders);
  }, [providedProjects, reminders]);

  const startTransition = useCallback(() => {
    setIsTransitioning(true);

    if (transitionTimeoutRef.current) {
      clearTimeout(transitionTimeoutRef.current);
    }

    transitionTimeoutRef.current = setTimeout(() => {
      setIsTransitioning(false);
    }, PAGE_TRANSITION_DURATION * 1000);
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    startTransition();
    setViewMode(mode);
    setSelectedProject(null);
  }, [startTransition]);

  const handleProjectSelect = useCallback((project: string) => {
    startTransition();
    setSelectedProject(project);
  }, [startTransition]);

  const handleBackToProjects = useCallback(() => {
    startTransition();
    setSelectedProject(null);
  }, [startTransition]);

  const headerData = useMemo(() => {
    return getRemindersHeaderData(reminders, projects, upcomingDays);
  }, [reminders, projects, upcomingDays]);

  const currentHeader = useMemo(() => {
    return getCurrentHeaderData(viewMode, headerData);
  }, [headerData, viewMode]);

  const showFab = shouldShowReminderFab(viewMode, selectedProject);

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
      className="w-full justify-between h-10 px-0"
      endContent={
        <motion.span
          animate={{ rotate: showCompleted ? 180 : 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="inline-flex"
        >
          <ChevronDown size={18} />
        </motion.span>
      }
    >
      <span className="text-sm font-semibold reminders-muted-label">
        Completed ({count})
      </span>
    </ShadowDOMButton>
  ), []);

  const currentProject = getReorderProject(viewMode, selectedProject);

  const handleReorder = useCallback((orderedIds: string[]) => {
    if (!currentProject) return;
    void onReorder(currentProject, orderedIds);
  }, [currentProject, onReorder]);

  const viewPanels = (
    <AnimatePresence mode="sync">
      <RemindersViewPanels
        viewMode={viewMode}
        selectedProject={selectedProject}
        isInitialLoadComplete={isInitialLoadComplete}
        reminders={reminders}
        projects={projects}
        showFab={showFab}
        upcomingDays={upcomingDays}
        renderCard={panelCardRenderer}
        renderToggleButton={renderToggleButton}
        onProjectSelect={handleProjectSelect}
        onBackToProjects={handleBackToProjects}
        onReorder={handleReorder}
        onReorderDragActiveChange={onReorderDragActiveChange}
        colorScheme={isDarkMode ? "dark" : "light"}
        reorderInteraction={reorderInteraction}
      />
    </AnimatePresence>
  );

  const loadingCrossfade = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <HeroUIProvider>
      <div
        className={[
          "reminders-view",
          isDarkMode ? "dark" : "light",
          isFullScreen ? "is-fullscreen" : "",
          isModal ? "is-modal" : "",
          isCompact || hideTabBar ? "is-compact" : "",
          viewMode === "browse" && selectedProject ? "is-project-detail" : `is-${viewMode}`,
          className,
        ].filter(Boolean).join(" ")}
      >
        {topOverlay}

        <AnimatePresence initial={false}>
          {!(viewMode === "browse" && selectedProject) && (
            <motion.div
              key="view-header"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{
                height: { duration: PAGE_TRANSITION_DURATION, ease: "easeOut" },
                opacity: { duration: 0.18, ease: "easeOut" },
              }}
              className="overflow-hidden"
            >
              <ViewHeader
                {...currentHeader}
                large={isFullScreen}
                showMeta={isInitialLoadComplete && !loadingContent}
                rightContent={headerRightContent}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {belowHeaderContent}

        <div className={`reminders-content${isTransitioning ? " is-transitioning" : ""}${loadingTransition ? " has-loading-transition" : ""}`}>
          {loadingTransition ? (
            <AnimatePresence initial={false} mode="sync">
              {loadingContent ? (
                <motion.div
                  key="initial-loading"
                  className="reminders-loading-transition-layer"
                  initial={false}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={loadingCrossfade}
                >
                  {loadingContent}
                </motion.div>
              ) : (
                <motion.div
                  key="initial-content"
                  className="reminders-loading-transition-layer"
                  initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={loadingCrossfade}
                >
                  {viewPanels}
                </motion.div>
              )}
            </AnimatePresence>
          ) : loadingContent ? loadingContent : viewPanels}
        </div>

        {!hideTabBar && (
          <BottomTabBar
            activeTab={viewMode}
            onTabChange={handleViewModeChange}
            className="animated-tab-bar animated-tab-bar-bottom"
          />
        )}

        <AnimatePresence>
          {showFab && !loadingContent && !suppressFab && (
            <FloatingActionButton
              onClick={handleAdd}
              className="fab"
              data-action="open-create-modal"
            />
          )}
        </AnimatePresence>

        {children}
      </div>
    </HeroUIProvider>
  );
};
