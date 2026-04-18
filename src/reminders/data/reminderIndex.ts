/**
 * Reminder Index - In-memory index derived from markdown files
 *
 * Provides fast queries for reminders parsed from vault markdown files.
 * This is NOT the source of truth - markdown files are.
 * The index is rebuilt from markdown on startup and updated incrementally.
 */

import type { App, TFile } from "obsidian";
import { createLogger, type Priority, type RecurrenceRule, type Reminder } from "@/reminders";
import { isReminderOverdue, isReminderToday, isReminderWithinDays } from "./reminderIndexDates";
import { createReminderLookupStore } from "./reminderIndexLookupStore";
import { createReminderOptimisticState } from "./reminderIndexOptimisticState";
import { getProjectFromPath, isInRemindersFolder, scanFile, scanVault, type ScanResult } from "./vaultScanner";

const log = createLogger("ReminderIndex");

type IndexChangeListener = () => void;

export interface IndexedReminder {
  id: string;
  content: string;
  dueDate?: string;
  dueDatetime?: string;
  priority: Priority;
  completed: boolean;
  project?: string;
  recurrence?: RecurrenceRule;
  description?: string;
  filePath: string;
  lineNumber: number;
  rawLine: string;
  contentHash: string;
}

export interface ReminderIndex {
  isLoaded: boolean;
  lastScanTime?: Date;
  scanDurationMs?: number;
  remindersFolderPath: string;

  getAll(): IndexedReminder[];
  getActive(): IndexedReminder[];
  getCompleted(): IndexedReminder[];
  getToday(): IndexedReminder[];
  getUpcoming(days: number): IndexedReminder[];
  getOverdue(): IndexedReminder[];
  getByProject(project: string): IndexedReminder[];
  getByFile(filePath: string): IndexedReminder[];
  getById(id: string): IndexedReminder | undefined;
  getProjects(): string[];

  load(): Promise<ScanResult>;
  rescanFile(file: TFile, force?: boolean): Promise<void>;
  removeFile(filePath: string): void;
  renameFile(oldPath: string, newPath: string): void;

  isReminderFile(filePath: string): boolean;
  onIndexChange(listener: IndexChangeListener): () => void;

  applyOptimisticCreate(reminder: IndexedReminder): void;
  applyOptimisticUpdate(id: string, updates: Partial<IndexedReminder>): void;
  applyOptimisticDelete(id: string): void;
  clearOptimistic(id: string): void;
}

export function createReminderIndex(app: App, remindersFolderPath: string): ReminderIndex {
  let reminders: IndexedReminder[] = [];
  let isLoaded = false;
  let lastScanTime: Date | undefined;
  let scanDurationMs: number | undefined;
  let discoveredProjects = new Set<string>();

  const listeners = new Set<IndexChangeListener>();
  const fileRescanTimestamps = new Map<string, number>();
  const lookupStore = createReminderLookupStore();
  const optimisticState = createReminderOptimisticState();
  const RESCAN_DEBOUNCE_MS = 1500;

  function notifyListeners(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log.error("Error in index change listener:", error);
      }
    }
  }

  function getMergedReminders(): IndexedReminder[] {
    return optimisticState.mergeReminders(reminders);
  }

  return {
    get isLoaded() {
      return isLoaded;
    },
    get lastScanTime() {
      return lastScanTime;
    },
    get scanDurationMs() {
      return scanDurationMs;
    },
    get remindersFolderPath() {
      return remindersFolderPath;
    },

    getAll() {
      return getMergedReminders();
    },

    getActive() {
      return getMergedReminders().filter((reminder) => !reminder.completed);
    },

    getCompleted() {
      return getMergedReminders().filter((reminder) => reminder.completed);
    },

    getToday() {
      return getMergedReminders().filter(
        (reminder) => !reminder.completed && isReminderToday(reminder.dueDatetime || reminder.dueDate),
      );
    },

    getUpcoming(days: number) {
      return getMergedReminders().filter(
        (reminder) => !reminder.completed && isReminderWithinDays(reminder.dueDatetime || reminder.dueDate, days),
      );
    },

    getOverdue() {
      return getMergedReminders().filter((reminder) =>
        isReminderOverdue(reminder.dueDatetime || reminder.dueDate, reminder.completed),
      );
    },

    getByProject(project: string) {
      return getMergedReminders().filter((reminder) => reminder.project === project);
    },

    getByFile(filePath: string) {
      return getMergedReminders().filter((reminder) => reminder.filePath === filePath);
    },

    getById(id: string) {
      return optimisticState.getById(id, lookupStore.getById(id));
    },

    getProjects() {
      return lookupStore.getProjects(discoveredProjects);
    },

    isReminderFile(filePath: string) {
      return isInRemindersFolder(filePath, remindersFolderPath);
    },

    async load() {
      log.info(` Starting scan of ${remindersFolderPath}/...`);
      const result = await scanVault(app, remindersFolderPath);

      reminders = result.reminders;
      isLoaded = true;
      lastScanTime = new Date();
      scanDurationMs = result.scanDurationMs;
      discoveredProjects = new Set(result.discoveredProjects);

      lookupStore.rebuild(reminders);
      notifyListeners();

      log.info(` Index loaded with ${reminders.length} reminders from ${result.filesScanned} files`);
      return result;
    },

    async rescanFile(file: TFile, force = false) {
      const filePath = file.path;
      if (!isInRemindersFolder(filePath, remindersFolderPath)) {
        return;
      }

      const lastRescan = fileRescanTimestamps.get(filePath);
      const now = Date.now();
      if (!force && lastRescan && now - lastRescan < RESCAN_DEBOUNCE_MS) {
        log.info(` Skipping rescan of ${filePath} - debounced (${now - lastRescan}ms since last scan)`);
        return;
      }

      log.info(` Rescanning file: ${filePath}`);
      fileRescanTimestamps.set(filePath, now);

      discoveredProjects.add(getProjectFromPath(filePath, remindersFolderPath));

      const persistedReminders = lookupStore.getByFile(filePath);
      optimisticState.clearFileState(filePath, persistedReminders);

      lookupStore.removeFile(filePath);
      reminders = reminders.filter((reminder) => reminder.filePath !== filePath);

      const result = await scanFile(app, file, remindersFolderPath);
      reminders.push(...result.reminders);
      lookupStore.addReminders(result.reminders);
      notifyListeners();

      log.info(` File rescanned, found ${result.reminders.length} reminders`);
    },

    removeFile(filePath: string) {
      log.info(` Removing file from index: ${filePath}`);
      const before = reminders.length;

      lookupStore.removeFile(filePath);
      reminders = reminders.filter((reminder) => reminder.filePath !== filePath);
      discoveredProjects.delete(getProjectFromPath(filePath, remindersFolderPath));

      notifyListeners();
      log.info(` Removed ${before - reminders.length} reminders`);
    },

    renameFile(oldPath: string, newPath: string) {
      log.info(` Renaming file in index: ${oldPath} -> ${newPath}`);

      const oldProject = getProjectFromPath(oldPath, remindersFolderPath);
      const newProject = getProjectFromPath(newPath, remindersFolderPath);
      discoveredProjects.delete(oldProject);
      discoveredProjects.add(newProject);

      lookupStore.renameFile(oldPath, newPath, newProject);
      notifyListeners();
    },

    onIndexChange(listener: IndexChangeListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    applyOptimisticCreate(reminder: IndexedReminder) {
      optimisticState.applyCreate(reminder);
      notifyListeners();
    },

    applyOptimisticUpdate(id: string, updates: Partial<IndexedReminder>) {
      optimisticState.applyUpdate(id, updates);
      notifyListeners();
    },

    applyOptimisticDelete(id: string) {
      optimisticState.applyDelete(id);
      notifyListeners();
    },

    clearOptimistic(id: string) {
      optimisticState.clear(id);
    },
  };
}

export function indexedToReminder(indexed: IndexedReminder): Reminder {
  const now = new Date().toISOString();
  return {
    id: indexed.id,
    content: indexed.content,
    description: indexed.description,
    dueDate: indexed.dueDate,
    dueDatetime: indexed.dueDatetime,
    priority: indexed.priority,
    completed: indexed.completed,
    project: indexed.project,
    fileLink: indexed.filePath,
    recurrence: indexed.recurrence,
    lineNumber: indexed.lineNumber,
    createdAt: now,
    updatedAt: now,
    completedAt: indexed.completed ? now : undefined,
  };
}
