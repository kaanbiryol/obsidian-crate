import React from "react";
import { motion, type Easing } from "framer-motion";
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
}) => {
  const tabContainerStyle: React.CSSProperties = {
    display: "flex",
    height: "100%",
    flexDirection: "column",
  };
  const easeExpoOut = EASE_EXPO_OUT as unknown as Easing;
  const pageTransition = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: {
      duration: PAGE_TRANSITION_DURATION,
      ease: easeExpoOut,
    },
  };

  switch (viewMode) {
    case "inbox":
      return (
        <motion.div key="inbox" style={tabContainerStyle} {...pageTransition}>
          <InboxView
            reminders={reminders}
            renderCard={renderCard}
            renderToggleButton={renderToggleButton}
            hasFab={showFab}
            onReorder={onReorder}
          />
        </motion.div>
      );
    case "today":
      return (
        <motion.div key="today" style={tabContainerStyle} {...pageTransition}>
          <TodayView reminders={reminders} renderCard={renderCard} hasFab={showFab} />
        </motion.div>
      );
    case "upcoming":
      return (
        <motion.div key="upcoming" style={tabContainerStyle} {...pageTransition}>
          <UpcomingView
            reminders={reminders}
            renderCard={renderCard}
            days={upcomingDays}
            hasFab={showFab}
          />
        </motion.div>
      );
    case "browse":
      if (!selectedProject) {
        return (
          <motion.div key="browse" style={tabContainerStyle} {...pageTransition}>
            <BrowseView
              projects={projects}
              reminders={reminders}
              onProjectSelect={onProjectSelect}
            />
          </motion.div>
        );
      }

      if (!isInitialLoadComplete) {
        return null;
      }

      return (
        <motion.div key={`project-${selectedProject}`} style={tabContainerStyle} {...pageTransition}>
          <ProjectDetailView
            project={selectedProject}
            reminders={reminders}
            onBack={onBackToProjects}
            animationConfig={{ enabled: false }}
            renderCard={renderCard}
            hasFab={showFab}
            onReorder={onReorder}
          />
        </motion.div>
      );
  }
};
