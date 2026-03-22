import { create } from "zustand";
import type { TabId } from "@/reminders";

export type DueDateDefaultSetting = "none" | "today" | "tomorrow";

export type AutoOpenSetting = "none" | "sidebar" | "fullscreen";

type QueryViewPreference = {
  showCompleted?: boolean;
};

const defaultSettings: RemindersSettings = {
  debugLogging: true,
  taskCreationDefaultDueDate: "none",
  remindersFolderPath: "Reminders",
  queryViewPreferences: {},
  upcomingDaysDefault: 7,
  autoOpenView: "none",
  sidebarDefaultTab: "inbox" as TabId,
  fullscreenDefaultTab: "inbox" as TabId,
};

export type RemindersSettings = {
  debugLogging: boolean;
  taskCreationDefaultDueDate: DueDateDefaultSetting;
  remindersFolderPath: string;
  queryViewPreferences: Record<string, QueryViewPreference>;
  upcomingDaysDefault: number;
  autoOpenView: AutoOpenSetting;
  sidebarDefaultTab: TabId;
  fullscreenDefaultTab: TabId;
};

export const useRemindersSettingsStore = create<RemindersSettings>(() => ({
  ...defaultSettings,
}));
