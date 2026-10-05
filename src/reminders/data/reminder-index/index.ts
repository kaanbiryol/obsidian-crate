/**
 * Reminder Index - In-memory index derived from markdown files
 *
 * Provides fast queries for reminders parsed from vault markdown files.
 * This is NOT the source of truth - markdown files are.
 * The index is rebuilt from markdown on startup and updated incrementally.
 */

import { TFile, type App } from "obsidian";
import type { Priority, RecurrenceRule } from "@/reminders/types/reminder";
import { createLogger } from "@/reminders/utils/logger";
import { isReminderOverdue, isReminderToday, isReminderWithinDays } from "./dates";
import { createReminderLookupStore } from "./lookup-store";
import { createReminderOptimisticState } from "./optimistic-state";
import { getProjectFromPath, isInRemindersFolder, scanFile, scanVault, type ScanResult } from "../vaultScanner";
import { addReminderIdentityOwners, type ReminderIdentityOwner, type ReminderIdentityOwners } from '../reminder-identity-owners';
import type { ReminderSourceIssue } from '../reminder-source-issues';

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
  readonly isInitialLoadComplete: boolean;
  readonly sourceIssues: ReminderSourceIssue[];
  readonly isComplete: boolean;
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
  rescanFile(file: TFile): Promise<void>;
  flushDeferredScans(): Promise<void>;
  removeFile(filePath: string): void;
  renameFile(oldPath: string, newPath: string): void;

  isReminderFile(filePath: string): boolean;
  onIndexChange(listener: IndexChangeListener): () => void;

  applyOptimisticCreate(reminder: IndexedReminder): void;
  applyOptimisticUpdate(id: string, updates: Partial<IndexedReminder>): void;
  applyOptimisticDelete(id: string): void;
  clearOptimistic(id: string): void;
}

export function createReminderIndex(app: App, remindersFolderPath: string, signal?: AbortSignal, shouldDeferScan: (filePath?: string) => boolean = () => false, shouldDeferCollisionRepair = () => false): ReminderIndex {
  let reminders: IndexedReminder[] = [];
  let isLoaded = false;
  let isInitialLoadComplete = false;
  let lastScanTime: Date | undefined;
  let scanDurationMs: number | undefined;
  let discoveredProjects = new Set<string>();
  let ambiguousOwners: ReminderIdentityOwner[] = [];
  let sourceIssues = new Map<string, ReminderSourceIssue>();

  const listeners = new Set<IndexChangeListener>();
  const lookupStore = createReminderLookupStore();
  const optimisticState = createReminderOptimisticState();
  let scanQueue: Promise<unknown> = Promise.resolve();
  let structureRevision = 0;
  const pendingFileScans = new Set<{ path: string; current: boolean }>();
  function invalidateScans(...paths: string[]): void {
    structureRevision++;
    for (const scan of pendingFileScans) if (paths.includes(scan.path)) scan.current = false;
  }
  let deferredLoad = false;
  const deferredPaths = new Set<string>();
  const enqueueScan = <T>(scan: () => Promise<T>): Promise<T> => {
    const result = scanQueue.then(scan, scan);
    scanQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  signal?.addEventListener('abort', () => { deferredPaths.clear(); deferredLoad = false; }, { once: true });

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

  const index: ReminderIndex = {
    get isLoaded() {
      return isLoaded;
    },
    get isInitialLoadComplete() { return isInitialLoadComplete; },
    get sourceIssues() { return [...sourceIssues.values()]; },
    get isComplete() { return isLoaded && !sourceIssues.size && !deferredLoad && !deferredPaths.size; },
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

    load: () => enqueueScan(async () => {
      if (signal?.aborted || shouldDeferScan()) {
        deferredLoad = !signal?.aborted;
        return { reminders, issues: [...sourceIssues.values()], filesScanned: 0, totalLines: 0, scanDurationMs: 0, discoveredProjects: [...discoveredProjects], deferred: true };
      }
      log.info(` Starting scan of ${remindersFolderPath}/...`);
      let result: ScanResult;
      let revision: number;
      do {
        revision = structureRevision;
        result = await scanVault(app, remindersFolderPath, signal,
          path => revision !== structureRevision || shouldDeferScan(path),
          shouldDeferCollisionRepair, [...reminders, ...ambiguousOwners]);
        // A rename or deletion updates the visible index immediately. Re-read
        // the inventory before publishing a snapshot that crossed that event.
      } while (!signal?.aborted && revision !== structureRevision);
      if (signal?.aborted) return result;
      if (result.deferred) {
        deferredLoad = true;
        for (const issue of result.issues) sourceIssues.set(issue.path, issue);
        ambiguousOwners = result.ambiguousOwners ?? ambiguousOwners;
        if (!isLoaded) {
          reminders = result.reminders;
          discoveredProjects = new Set(result.discoveredProjects);
          lookupStore.rebuild(reminders);
          isLoaded = true;
        }
        notifyListeners();
        return result;
      }

      deferredLoad = false;
      isInitialLoadComplete = true;
      sourceIssues = new Map(result.issues.map(issue => [issue.path, issue]));
      reminders = [...result.reminders, ...reminders.filter(reminder => sourceIssues.has(reminder.filePath))];
      ambiguousOwners = [];
      isLoaded = true;
      if (!sourceIssues.size) lastScanTime = new Date();
      scanDurationMs = result.scanDurationMs;
      discoveredProjects = new Set(result.discoveredProjects);

      lookupStore.rebuild(reminders);
      notifyListeners();

      log.info(` Index loaded with ${reminders.length} reminders from ${result.filesScanned} files`);
      return result;
    }),

    rescanFile: (file: TFile) => {
      // Capture the path when work is requested, including time spent queued.
      // The watcher owns debounce; an accepted scan must not drop a newer edit.
      const scan = { path: file.path, current: true };
      pendingFileScans.add(scan);
      return enqueueScan(async () => {
        if (signal?.aborted || !scan.current || file.path !== scan.path) return;
        const filePath = scan.path;
        if (!isInRemindersFolder(filePath, remindersFolderPath)) {
          return;
        }
        if (shouldDeferScan(filePath)) {
          deferredPaths.add(filePath);
          return;
        }

        log.info(` Rescanning file: ${filePath}`);

        const identityOwners: ReminderIdentityOwners = new Map();
        addReminderIdentityOwners(identityOwners, reminders);
        addReminderIdentityOwners(identityOwners, ambiguousOwners);
        const result = await scanFile(app, file, remindersFolderPath, new Set(), signal, identityOwners,
          () => !scan.current || file.path !== scan.path || shouldDeferScan(filePath), shouldDeferCollisionRepair);
        if (signal?.aborted || !scan.current || file.path !== scan.path) return;
        if (result.deferred) { deferredPaths.add(filePath); return; }
        if (result.error) {
          sourceIssues.set(filePath, { path: filePath, reason: result.error, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
          log.error(` Keeping the previous reminder index for ${filePath}: ${result.error}`);
          notifyListeners();
          return;
        }

        sourceIssues.delete(filePath);

        discoveredProjects.add(getProjectFromPath(filePath, remindersFolderPath));

        const persistedReminders = lookupStore.getByFile(filePath);
        optimisticState.clearFileState(filePath, [...persistedReminders, ...result.reminders]);

        const released = new Set((result.releasedOwners ?? []).map(owner => `${owner.filePath}\0${owner.id}`));
        ambiguousOwners = ambiguousOwners.filter(owner => owner.filePath !== filePath && !released.has(`${owner.filePath}\0${owner.id}`));
        reminders = reminders.filter(reminder => reminder.filePath !== filePath && !released.has(`${reminder.filePath}\0${reminder.id}`));

        reminders.push(...result.reminders);
        // A move can release an indexed owner that has not received its own
        // refresh yet. Publish the ownership transfer as one index transition.
        if (released.size) lookupStore.rebuild(reminders);
        else {
          lookupStore.removeFile(filePath);
          lookupStore.addReminders(result.reminders);
        }
        notifyListeners();

        log.info(` File rescanned, found ${result.reminders.length} reminders`);
        if (deferredPaths.size) void index.flushDeferredScans().catch(error => log.error('Deferred reminder scan failed:', error));
      }).finally(() => pendingFileScans.delete(scan));
    },

    async flushDeferredScans() {
      await scanQueue;
      if (signal?.aborted || shouldDeferScan()) return;
      if (deferredLoad) {
        deferredLoad = false;
        deferredPaths.clear();
        await index.load();
        return;
      }
      const paths = [...deferredPaths];
      deferredPaths.clear();
      for (const path of paths) {
        if (signal?.aborted) return;
        const file = app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await index.rescanFile(file);
        else index.removeFile(path);
      }
    },

    removeFile(filePath: string) {
      invalidateScans(filePath);
      deferredPaths.delete(filePath);
      sourceIssues.delete(filePath);
      ambiguousOwners = ambiguousOwners.filter(owner => owner.filePath !== filePath);
      log.info(` Removing file from index: ${filePath}`);
      const before = reminders.length;

      lookupStore.removeFile(filePath);
      reminders = reminders.filter((reminder) => reminder.filePath !== filePath);
      discoveredProjects.delete(getProjectFromPath(filePath, remindersFolderPath));

      notifyListeners();
      log.info(` Removed ${before - reminders.length} reminders`);
    },

    renameFile(oldPath: string, newPath: string) {
      invalidateScans(oldPath, newPath);
      if (deferredPaths.delete(oldPath)) deferredPaths.add(newPath);
      const issue = sourceIssues.get(oldPath);
      if (issue) { sourceIssues.delete(oldPath); sourceIssues.set(newPath, { ...issue, path: newPath }); }
      ambiguousOwners = ambiguousOwners.map(owner => owner.filePath === oldPath ? { ...owner, filePath: newPath } : owner);
      log.info(` Renaming file in index: ${oldPath} -> ${newPath}`);

      const oldProject = getProjectFromPath(oldPath, remindersFolderPath);
      const newProject = getProjectFromPath(newPath, remindersFolderPath);
      discoveredProjects.delete(oldProject);
      discoveredProjects.add(newProject);

      // The index owns records; lookup maps only track the published values.
      // Remove the old keys before changing the records they reference.
      const moved = lookupStore.removeFile(oldPath);
      for (const reminder of moved) {
        reminder.filePath = newPath;
        reminder.project = newProject;
      }
      lookupStore.addReminders(moved);
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
      notifyListeners();
    },
  };
  return index;
}
