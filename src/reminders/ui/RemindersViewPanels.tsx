import React from "react";
import { motion } from "framer-motion";
import {
  BrowseView,
  InboxView,
  ProjectDetailView,
  TodayView,
  UpcomingView,
} from "@/reminders/ui/views";
import {
  EASE_EXPO_OUT,
  PAGE_TRANSITION_DURATION,
} from "@/reminders/ui/layoutConstants";
import type { Reminder as SharedReminder } from "@/reminders/types/reminder";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import type { ViewMode } from "./remindersViewModel";
import type { ProjectColorScheme } from "@/reminders/utils/projectColors";

interface RemindersViewPanelsProps {
  viewMode: ViewMode;
  selectedProject: string | null;
  isInitialLoadComplete: boolean;
  reminders: Reminder[];
  projects: string[];
  showFab: boolean;
  upcomingDays: number;
  renderCard: (reminder: SharedReminder, index: number) => React.ReactNode;
  renderToggleButton: (props: {
    onPress: () => void;
    showCompleted: boolean;
    count: number;
  }) => React.ReactNode;
  onProjectSelect: (project: string) => void;
  onBackToProjects: () => void;
  onReorder: (orderedIds: string[]) => void;
  onReorderDragActiveChange?: (active: boolean) => void;
  colorScheme: ProjectColorScheme;
  reorderInteraction?: 'handle' | 'long-press';
  animationsEnabled?: boolean;
}

export const RemindersViewPanels: React.FC<RemindersViewPanelsProps> = ({
  viewMode,
  selectedProject,
  isInitialLoadComplete,
  reminders,
  projects,
  showFab,
  upcomingDays,
  renderCard,
  renderToggleButton,
  onProjectSelect,
  onBackToProjects,
  onReorder,
  onReorderDragActiveChange,
  colorScheme,
  reorderInteraction = 'handle',
  animationsEnabled = true,
}) => {
  const pageTransition = {
    initial: animationsEnabled ? { opacity: 0 } : false,
    animate: { opacity: 1 },
    exit: animationsEnabled ? { opacity: 0 } : undefined,
    transition: {
      duration: animationsEnabled ? PAGE_TRANSITION_DURATION : 0,
      ease: EASE_EXPO_OUT,
    },
  };

  switch (viewMode) {
    case "inbox":
      return (
        <motion.div key="inbox" className="reminders-view-panel" {...pageTransition}>
          <InboxView
            reminders={reminders}
            renderCard={renderCard}
            renderToggleButton={renderToggleButton}
            hasFab={showFab}
            onReorder={onReorder}
            onReorderDragActiveChange={onReorderDragActiveChange}
            colorScheme={colorScheme}
            reorderInteraction={reorderInteraction}
            animationConfig={{ enabled: animationsEnabled }}
          />
        </motion.div>
      );
    case "today":
      return (
        <motion.div key="today" className="reminders-view-panel" {...pageTransition}>
          <TodayView reminders={reminders} renderCard={renderCard} hasFab={showFab} colorScheme={colorScheme} animationConfig={{ enabled: animationsEnabled }} />
        </motion.div>
      );
    case "upcoming":
      return (
        <motion.div key="upcoming" className="reminders-view-panel" {...pageTransition}>
          <UpcomingView
            reminders={reminders}
            renderCard={renderCard}
            days={upcomingDays}
            hasFab={showFab}
            colorScheme={colorScheme}
            animationConfig={{ enabled: animationsEnabled }}
          />
        </motion.div>
      );
    case "browse":
      if (!selectedProject) {
        return (
          <motion.div key="browse" className="reminders-view-panel" {...pageTransition}>
            <BrowseView
              projects={projects}
              reminders={reminders}
              onProjectSelect={onProjectSelect}
              colorScheme={colorScheme}
              animationConfig={{ enabled: animationsEnabled }}
            />
          </motion.div>
        );
      }

      if (!isInitialLoadComplete) {
        return null;
      }

      return (
        <motion.div key={`project-${selectedProject}`} className="reminders-view-panel" {...pageTransition}>
          <ProjectDetailView
            project={selectedProject}
            reminders={reminders}
            onBack={onBackToProjects}
            animationConfig={{ enabled: false }}
            renderCard={renderCard}
            hasFab={showFab}
            onReorder={onReorder}
            onReorderDragActiveChange={onReorderDragActiveChange}
            colorScheme={colorScheme}
            reorderInteraction={reorderInteraction}
          />
        </motion.div>
      );
  }
};
