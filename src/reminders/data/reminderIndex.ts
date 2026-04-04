/**
 * Reminder Index - In-memory index derived from markdown files
 *
 * Provides fast queries for reminders parsed from vault markdown files.
 * This is NOT the source of truth - markdown files are.
 * The index is rebuilt from markdown on startup and updated incrementally.
 */

import type { App, TFile } from "obsidian";
import { createLogger, type Priority, type RecurrenceRule, type Reminder } from "@/reminders";
import { formatLocalDateKey, isDateOnlyString, parseReminderDateValue } from "@/reminders/utils/reminderDate";
import { scanVault, scanFile, isInRemindersFolder, getProjectFromPath, type ScanResult } from "./vaultScanner";

const log = createLogger('ReminderIndex');

/**
 * Listener type for index change events
 */
type IndexChangeListener = () => void;

export interface IndexedReminder {
  id: string;
  content: string;
  dueDate?: string; // YYYY-MM-DD
  dueDatetime?: string; // ISO datetime
  priority: Priority;
  completed: boolean;
  project?: string;
  recurrence?: RecurrenceRule;

  // Location tracking (critical for write-back)
  filePath: string;
  lineNumber: number;
  rawLine: string; // Original line for verification
  contentHash: string; // Detect if line changed
}

export interface ReminderIndex {
  // Index state
  isLoaded: boolean;
  lastScanTime?: Date;
  scanDurationMs?: number;
  remindersFolderPath: string;

  // Query methods
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

  // Lifecycle
  load(): Promise<ScanResult>;
  rescanFile(file: TFile, force?: boolean): Promise<void>;
  removeFile(filePath: string): void;
  renameFile(oldPath: string, newPath: string): void;

  // Check if file is in reminders folder
  isReminderFile(filePath: string): boolean;

  // Event subscription
  onIndexChange(listener: IndexChangeListener): () => void;

  // Optimistic state management
  applyOptimisticCreate(reminder: IndexedReminder): void;
  applyOptimisticUpdate(id: string, updates: Partial<IndexedReminder>): void;
  applyOptimisticDelete(id: string): void;
  clearOptimistic(id: string): void;
}

/**
 * Create a new reminder index for the given Obsidian app
 * @param app - Obsidian app instance
 * @param remindersFolderPath - Path to the folder containing reminder files
 */
export function createReminderIndex(
  app: App,
  remindersFolderPath: string
): ReminderIndex {
  // Internal state
  let reminders: IndexedReminder[] = [];
  let isLoaded = false;
  let lastScanTime: Date | undefined;
  let scanDurationMs: number | undefined;

  // Indexes for fast lookups
  let byId: Map<string, IndexedReminder> = new Map();
  let byFile: Map<string, IndexedReminder[]> = new Map();
  let byProject: Map<string, IndexedReminder[]> = new Map();

  // Track all discovered projects from file paths (including empty files)
  let discoveredProjects: Set<string> = new Set();

  // Listener registry for change notifications
  const listeners: Set<IndexChangeListener> = new Set();

  // Track last rescan time per file to prevent redundant rescans
  const fileRescanTimestamps: Map<string, number> = new Map();
  const RESCAN_DEBOUNCE_MS = 1500; // Minimum time between rescans of same file

  // Optimistic state - allows UI to update immediately before file writes complete
  const optimisticCreates: Map<string, IndexedReminder> = new Map();
  const optimisticUpdates: Map<string, Partial<IndexedReminder>> = new Map();
  const optimisticDeletes: Set<string> = new Set();

  /**
   * Notify all listeners that the index has changed
   */
  function notifyListeners(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log.error("Error in index change listener:", error);
      }
    }
  }

  /**
   * Rebuild lookup indexes from reminders array (full rebuild)
   */
  function rebuildIndexes(): void {
    byId = new Map();
    byFile = new Map();
    byProject = new Map();

    for (const reminder of reminders) {
      byId.set(reminder.id, reminder);

      // Index by file
      const fileReminders = byFile.get(reminder.filePath) || [];
      fileReminders.push(reminder);
      byFile.set(reminder.filePath, fileReminders);

      // Index by project
      if (reminder.project) {
        const projectReminders = byProject.get(reminder.project) || [];
        projectReminders.push(reminder);
        byProject.set(reminder.project, projectReminders);
      }
    }
  }

  /**
   * Remove entries for a specific file from all indexes (partial update)
   */
  function removeFileFromIndexes(filePath: string): void {
    // Get old reminders for this file before removing
    const oldReminders = byFile.get(filePath) || [];

    // Remove from byId
    for (const reminder of oldReminders) {
      byId.delete(reminder.id);

      // Remove from byProject
      if (reminder.project) {
        const projectReminders = byProject.get(reminder.project);
        if (projectReminders) {
          const filtered = projectReminders.filter(r => r.id !== reminder.id);
          if (filtered.length > 0) {
            byProject.set(reminder.project, filtered);
          } else {
            byProject.delete(reminder.project);
          }
        }
      }
    }

    // Remove from byFile
    byFile.delete(filePath);
  }

  /**
   * Add reminders to all indexes (partial update)
   */
  function addRemindersToIndexes(newReminders: IndexedReminder[]): void {
    for (const reminder of newReminders) {
      byId.set(reminder.id, reminder);

      // Index by file
      const fileReminders = byFile.get(reminder.filePath) || [];
      fileReminders.push(reminder);
      byFile.set(reminder.filePath, fileReminders);

      // Index by project
      if (reminder.project) {
        const projectReminders = byProject.get(reminder.project) || [];
        projectReminders.push(reminder);
        byProject.set(reminder.project, projectReminders);
      }
    }
  }

  /**
   * Check if a date string is today
   */
  function isToday(dateStr: string | undefined): boolean {
    if (!dateStr) return false;
    if (isDateOnlyString(dateStr)) {
      return dateStr === formatLocalDateKey(new Date());
    }
    const date = new Date(dateStr);
    const today = new Date();
    return (
      date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate()
    );
  }

  /**
   * Check if a date is within N days from now
   */
  function isWithinDays(dateStr: string | undefined, days: number): boolean {
    if (!dateStr) return false;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endDate = new Date(todayStart);
    endDate.setDate(endDate.getDate() + days + 1);

    if (isDateOnlyString(dateStr)) {
      const date = parseReminderDateValue(dateStr, false);
      if (!date) return false;
      const tomorrowStart = new Date(todayStart);
      tomorrowStart.setDate(tomorrowStart.getDate() + 1);
      return date >= tomorrowStart && date < endDate;
    }

    const date = new Date(dateStr);
    return date > now && date < endDate;
  }

  /**
   * Check if a date is in the past
   */
  function isOverdue(dateStr: string | undefined, completed: boolean): boolean {
    if (!dateStr || completed) return false;
    if (isDateOnlyString(dateStr)) {
      return dateStr < formatLocalDateKey(new Date());
    }
    return new Date(dateStr) < new Date();
  }

  /**
   * Get all reminders with optimistic state merged in
   * This is the single source of truth for UI rendering
   */
  function getMergedReminders(): IndexedReminder[] {
    // Start with actual reminders, excluding optimistically deleted ones
    const actual = reminders.filter(r => !optimisticDeletes.has(r.id));

    // Apply optimistic updates to actual reminders
    const withUpdates = actual.map(r => {
      const updates = optimisticUpdates.get(r.id);
      return updates ? { ...r, ...updates } : r;
    });

    // Add optimistically created reminders
    return [...withUpdates, ...Array.from(optimisticCreates.values())];
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

    getAll(): IndexedReminder[] {
      return getMergedReminders();
    },

    getActive(): IndexedReminder[] {
      return getMergedReminders().filter((r) => !r.completed);
    },

    getCompleted(): IndexedReminder[] {
      return getMergedReminders().filter((r) => r.completed);
    },

    getToday(): IndexedReminder[] {
      return getMergedReminders().filter(
        (r) => !r.completed && isToday(r.dueDatetime || r.dueDate)
      );
    },

    getUpcoming(days: number): IndexedReminder[] {
      return getMergedReminders().filter(
        (r) => !r.completed && isWithinDays(r.dueDatetime || r.dueDate, days)
      );
    },

    getOverdue(): IndexedReminder[] {
      return getMergedReminders().filter((r) =>
        isOverdue(r.dueDatetime || r.dueDate, r.completed)
      );
    },

    getByProject(project: string): IndexedReminder[] {
      return getMergedReminders().filter(r => r.project === project);
    },

    getByFile(filePath: string): IndexedReminder[] {
      return getMergedReminders().filter(r => r.filePath === filePath);
    },

    getById(id: string): IndexedReminder | undefined {
      // Check optimistic deletes first
      if (optimisticDeletes.has(id)) {
        return undefined;
      }
      // Check optimistic creates
      const created = optimisticCreates.get(id);
      if (created) {
        return created;
      }
      // Get from actual data with potential updates
      const actual = byId.get(id);
      if (actual) {
        const updates = optimisticUpdates.get(id);
        return updates ? { ...actual, ...updates } : actual;
      }
      return undefined;
    },

    getProjects(): string[] {
      // Merge projects with reminders and discovered projects (including empty files)
      const allProjects = new Set([...byProject.keys(), ...discoveredProjects]);
      return Array.from(allProjects).sort();
    },

    isReminderFile(filePath: string): boolean {
      return isInRemindersFolder(filePath, remindersFolderPath);
    },

    async load(): Promise<ScanResult> {
      log.info(` Starting scan of ${remindersFolderPath}/...`);
      const result = await scanVault(app, remindersFolderPath);

      reminders = result.reminders;
      isLoaded = true;
      lastScanTime = new Date();
      scanDurationMs = result.scanDurationMs;

      // Store discovered projects (including empty files)
      discoveredProjects = new Set(result.discoveredProjects);

      rebuildIndexes();
      notifyListeners();

      log.info(
        ` Index loaded with ${reminders.length} reminders from ${result.filesScanned} files`
      );
      return result;
    },

    async rescanFile(file: TFile, force = false): Promise<void> {
      const filePath = file.path;

      // Only scan files in the reminders folder
      if (!isInRemindersFolder(filePath, remindersFolderPath)) {
        return;
      }

      // Check if we recently rescanned this file (debounce)
      const lastRescan = fileRescanTimestamps.get(filePath);
      const now = Date.now();
      if (!force && lastRescan && now - lastRescan < RESCAN_DEBOUNCE_MS) {
        log.info(` Skipping rescan of ${filePath} - debounced (${now - lastRescan}ms since last scan)`);
        return;
      }

      log.info(` Rescanning file: ${filePath}`);
      fileRescanTimestamps.set(filePath, now);

      // Add project from file path to discovered projects (handles new empty files)
      const project = getProjectFromPath(filePath, remindersFolderPath);
      discoveredProjects.add(project);

      // Clear optimistic state for reminders in this file (real data will replace it)
      const oldReminders = byFile.get(filePath) || [];
      for (const reminder of oldReminders) {
        optimisticUpdates.delete(reminder.id);
        optimisticDeletes.delete(reminder.id);
      }
      // Also clear optimistic creates for this file
      for (const [id, created] of optimisticCreates) {
        if (created.filePath === filePath) {
          optimisticCreates.delete(id);
        }
      }

      // Remove old entries for this file from indexes (partial update)
      removeFileFromIndexes(filePath);
      reminders = reminders.filter((r) => r.filePath !== filePath);

      // Scan the file for new entries
      const result = await scanFile(app, file, remindersFolderPath);
      reminders.push(...result.reminders);

      // Add new entries to indexes (partial update)
      addRemindersToIndexes(result.reminders);
      notifyListeners();

      log.info(
        ` File rescanned, found ${result.reminders.length} reminders`
      );
    },

    removeFile(filePath: string): void {
      log.info(` Removing file from index: ${filePath}`);
      const before = reminders.length;

      // Remove from indexes (partial update)
      removeFileFromIndexes(filePath);
      reminders = reminders.filter((r) => r.filePath !== filePath);

      // Remove project from discovered projects
      const project = getProjectFromPath(filePath, remindersFolderPath);
      discoveredProjects.delete(project);

      notifyListeners();
      log.info(
        ` Removed ${before - reminders.length} reminders`
      );
    },

    renameFile(oldPath: string, newPath: string): void {
      log.info(
        ` Renaming file in index: ${oldPath} -> ${newPath}`
      );

      // Update discovered projects
      const oldProject = getProjectFromPath(oldPath, remindersFolderPath);
      const newProject = getProjectFromPath(newPath, remindersFolderPath);
      discoveredProjects.delete(oldProject);
      discoveredProjects.add(newProject);

      // Get reminders for old path and update byFile index (partial update)
      const fileReminders = byFile.get(oldPath) || [];
      byFile.delete(oldPath);

      // Update file paths in reminders and project index
      for (const reminder of fileReminders) {
        reminder.filePath = newPath;

        // Update project in byProject if it changed
        if (reminder.project !== newProject) {
          // Remove from old project
          if (reminder.project) {
            const oldProjectReminders = byProject.get(reminder.project);
            if (oldProjectReminders) {
              const filtered = oldProjectReminders.filter(r => r.id !== reminder.id);
              if (filtered.length > 0) {
                byProject.set(reminder.project, filtered);
              } else {
                byProject.delete(reminder.project);
              }
            }
          }
          // Add to new project
          reminder.project = newProject;
          const newProjectReminders = byProject.get(newProject) || [];
          newProjectReminders.push(reminder);
          byProject.set(newProject, newProjectReminders);
        }
      }

      // Add to byFile under new path
      if (fileReminders.length > 0) {
        byFile.set(newPath, fileReminders);
      }

      notifyListeners();
    },

    onIndexChange(listener: IndexChangeListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // Optimistic state management methods
    applyOptimisticCreate(reminder: IndexedReminder): void {
      optimisticCreates.set(reminder.id, reminder);
      notifyListeners();
    },

    applyOptimisticUpdate(id: string, updates: Partial<IndexedReminder>): void {
      optimisticUpdates.set(id, updates);
      notifyListeners();
    },

    applyOptimisticDelete(id: string): void {
      optimisticDeletes.add(id);
      notifyListeners();
    },

    clearOptimistic(id: string): void {
      optimisticCreates.delete(id);
      optimisticUpdates.delete(id);
      optimisticDeletes.delete(id);
      // Note: no notifyListeners() here - the file rescan will trigger that
    },
  };
}

/**
 * Convert an IndexedReminder to a Reminder for compatibility with existing UI components
 */
export function indexedToReminder(indexed: IndexedReminder): Reminder {
  const now = new Date().toISOString();
  return {
    id: indexed.id,
    content: indexed.content,
    dueDate: indexed.dueDate,
    dueDatetime: indexed.dueDatetime,
    priority: indexed.priority,
    completed: indexed.completed,
    project: indexed.project,
    fileLink: indexed.filePath, // Map filePath to fileLink
    recurrence: indexed.recurrence,
    // Generate placeholder timestamps (not stored in markdown)
    createdAt: now,
    updatedAt: now,
    completedAt: indexed.completed ? now : undefined,
  };
}
