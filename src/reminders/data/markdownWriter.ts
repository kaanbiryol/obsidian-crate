/**
 * Markdown Writer - Writes reminders to markdown files
 *
 * Handles:
 * - Creating new reminders in project files (Reminders/{project}.md)
 * - Updating existing reminder lines
 * - Deleting reminder lines
 * - Toggling completion status
 */

import type { App, TFile } from "obsidian";
import { createLogger, type Priority, type Reminder, type RecurrenceRule, calculateNextOccurrence, calculateFirstOccurrence, generateContentHash } from "@/reminders";
import type { IndexedReminder, ReminderIndex } from "./reminderIndex";
import { generateReminderId } from "./reminderIdentity";
import { rebuildCheckboxLine } from "@/reminders/utils/checkboxParser";
import {
  buildStoredReminderDates,
  inferHasTimeFromDate,
  parseStoredReminderDate,
  reminderHasTime,
} from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";

export type ReminderOperation = "create" | "update" | "delete";

export interface ReminderChangeContext {
  recurringInstanceCompleted?: {
    completedDate: string;
    nextDate: string;
  };
}

export interface SyncResult {
  success: boolean;
  error?: string;
}

const log = createLogger('MarkdownWriter');

function isTFileLike(value: unknown): value is TFile {
  return typeof value === "object"
    && value !== null
    && "path" in value
    && typeof value.path === "string"
    && "extension" in value
    && typeof value.extension === "string";
}

/**
 * Callback for sync and notification orchestration.
 */
type OnReminderChangeCallback = (
  reminder: Reminder,
  operation: ReminderOperation,
  context?: ReminderChangeContext
) => Promise<SyncResult>;

/**
 * Callback triggered after a file is written, to immediately update the index.
 * This bypasses VaultWatcher's debounce for instant UI refresh.
 */
type OnFileWrittenCallback = (file: TFile) => Promise<void>;

/**
 * Convert IndexedReminder to Reminder for sync/notification callbacks
 */
function toReminder(indexed: IndexedReminder): Reminder {
  return {
    id: indexed.id,
    content: indexed.content,
    dueDate: indexed.dueDate,
    dueDatetime: indexed.dueDatetime,
    priority: indexed.priority,
    completed: indexed.completed,
    project: indexed.project || 'Inbox',
    recurrence: normalizeRecurrenceRule(indexed.recurrence),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export interface MarkdownWriter {
  /**
   * Create a new reminder in a project file
   * Writes to Reminders/{project}.md, creating the file if needed
   */
  createReminder(
    project: string,
    content: string,
    dueDate: Date | undefined,
    priority: Priority,
    recurrence?: RecurrenceRule,
    hasTime?: boolean,
  ): Promise<void>;

  /**
   * Update an existing reminder by its indexed data
   */
  updateReminder(
    reminder: IndexedReminder,
    updates: {
      content?: string;
      dueDate?: Date;
      priority?: Priority;
      project?: string;
      recurrence?: RecurrenceRule | null;
      hasTime?: boolean;
    }
  ): Promise<void>;

  /**
   * Delete a reminder line from its source file
   */
  deleteReminder(reminder: IndexedReminder): Promise<void>;

  /**
   * Toggle the completion status of a reminder
   */
  toggleComplete(reminder: IndexedReminder): Promise<void>;

  /**
   * Set callback for sync and notification orchestration.
   */
  setOnReminderChange(callback: OnReminderChangeCallback): void;

  /**
   * Set callback for immediate index rescan after file writes.
   * This bypasses VaultWatcher's debounce for instant UI refresh.
   */
  setOnFileWritten(callback: OnFileWrittenCallback): void;
}

/**
 * Create a markdown writer for the given app and index
 */
export function createMarkdownWriter(
  app: App,
  index: ReminderIndex
): MarkdownWriter {
  // Callback for sync and notification orchestration
  let onReminderChange: OnReminderChangeCallback | undefined;
  // Callback for immediate index rescan after file writes
  let onFileWritten: OnFileWrittenCallback | undefined;

  /**
   * Get a TFile from a path
   */
  async function getFile(filePath: string): Promise<TFile | null> {
    const abstractFile = app.vault.getAbstractFileByPath(filePath);
    if (isTFileLike(abstractFile)) {
      return abstractFile;
    }
    return null;
  }

  /**
   * Get or create a project file
   * Returns the file path: {remindersFolderPath}/{project}.md
   */
  async function getOrCreateProjectFile(project: string): Promise<TFile> {
    const folderPath = index.remindersFolderPath;
    const filePath = `${folderPath}/${project}.md`;

    // Check if folder exists, create if not
    const folderExists = await app.vault.adapter.exists(folderPath);
    if (!folderExists) {
      await app.vault.createFolder(folderPath);
      log.info(` Created folder: ${folderPath}`);
    }

    // Check if file exists
    let file = await getFile(filePath);
    if (!file) {
      // Create file with header
      const projectName = project.split("/").pop() || project;
      const initialContent = `# ${projectName}\n\n`;
      await app.vault.create(filePath, initialContent);
      file = await getFile(filePath);
      log.info(` Created project file: ${filePath}`);
    }

    if (!file) {
      throw new Error(`Failed to create project file: ${filePath}`);
    }

    return file;
  }

  return {
    async createReminder(
      project: string,
      content: string,
      dueDate: Date | undefined,
      priority: Priority,
      recurrence?: RecurrenceRule,
      hasTime?: boolean,
    ): Promise<void> {
      const normalizedRecurrence = normalizeRecurrenceRule(recurrence);
      // Get or create the project file
      const file = await getOrCreateProjectFile(project);

      // Read current content
      const fileContent = await app.vault.read(file);

      // Calculate initial date for recurring reminders if not provided
      let effectiveDueDate = dueDate;
      if (normalizedRecurrence && !dueDate) {
        effectiveDueDate = calculateFirstOccurrence(normalizedRecurrence);
      }
      const resolvedHasTime = hasTime ?? inferHasTimeFromDate(effectiveDueDate);
      const storedDates = buildStoredReminderDates(effectiveDueDate, resolvedHasTime);

      // Build the new reminder line
      const newLine = rebuildCheckboxLine(
        "",
        false,
        content,
        effectiveDueDate,
        priority,
        undefined,  // project (not used in line)
        normalizedRecurrence,
        resolvedHasTime,
      );

      // Generate ID and build optimistic reminder for immediate UI update
      const reminderId = generateReminderId(file.path, content);
      const contentHash = generateContentHash(content);
      const optimisticReminder: IndexedReminder = {
        id: reminderId,
        content,
        dueDate: storedDates.dueDate,
        dueDatetime: storedDates.dueDatetime,
        priority,
        completed: false,
        project,
        recurrence: normalizedRecurrence,
        filePath: file.path,
        lineNumber: -1, // Will be set by rescan
        rawLine: newLine,
        contentHash,
      };

      // Apply optimistic state immediately (UI updates)
      index.applyOptimisticCreate(optimisticReminder);

      // Append to bottom of file with empty line after header
      const trimmed = fileContent.trimEnd();
      const separator = trimmed.match(/^#[^\n]*$/) ? "\n\n" : "\n";
      const newContent = trimmed + separator + newLine + "\n";

      try {
        // Write back to file (fast, ~10ms)
        await app.vault.modify(file, newContent);
        log.info(`Created reminder in ${file.path}`);

        // Force index rescan (clears optimistic state with real data)
        if (onFileWritten) {
          await onFileWritten(file);
        }

        // Fire CalDAV sync in background (don't await)
        if (onReminderChange) {
          const reminder: Reminder & { contentHash: string } = {
            id: reminderId,
            content,
            dueDate: storedDates.dueDate,
            dueDatetime: storedDates.dueDatetime,
            priority,
            completed: false,
            project,
            recurrence: normalizedRecurrence,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contentHash,
          };
          onReminderChange(reminder, 'create').catch(err => {
            log.error('Sync failed for create', err);
          });
        }
      } catch (error) {
        // Rollback optimistic state on file write failure
        index.clearOptimistic(reminderId);
        throw error;
      }
    },

    async updateReminder(
      reminder: IndexedReminder,
      updates: {
        content?: string;
        dueDate?: Date;
        priority?: Priority;
        project?: string;
        recurrence?: RecurrenceRule | null;
        hasTime?: boolean;
      }
    ): Promise<void> {
      const newProject = updates.project ?? reminder.project;
      const oldProject = reminder.project || 'Inbox';
      const newRecurrence = Object.prototype.hasOwnProperty.call(updates, 'recurrence')
        ? normalizeRecurrenceRule(updates.recurrence ?? undefined)
        : normalizeRecurrenceRule(reminder.recurrence);
      const currentDueDate = parseStoredReminderDate(reminder);
      const currentHasTime = reminderHasTime(reminder);
      const newHasTime = Object.prototype.hasOwnProperty.call(updates, 'hasTime')
        ? updates.hasTime
        : ('dueDate' in updates ? inferHasTimeFromDate(updates.dueDate) : currentHasTime);

      // If project changed, move the reminder to the new file
      if (newProject && newProject !== oldProject) {
        log.info(`Moving reminder from ${oldProject} to ${newProject}`);

        // Build the updated values
        const newContent = updates.content ?? reminder.content;
        // Use 'in' check to distinguish "not provided" from "explicitly cleared to undefined"
        const newDueDate = 'dueDate' in updates
          ? updates.dueDate
          : currentDueDate;
        const newPriority = updates.priority ?? reminder.priority;

        // 1. Delete from old file
        await this.deleteReminder(reminder);

        // 2. Create in new file (without project tag since project = file name)
        await this.createReminder(newProject, newContent, newDueDate, newPriority, newRecurrence, newHasTime);

        return;
      }

      const file = await getFile(reminder.filePath);
      if (!file) {
        throw new Error(`File not found: ${reminder.filePath}`);
      }

      const fileContent = await app.vault.read(file);
      const lines = fileContent.split("\n");

      // Verify the line still matches
      if (
        reminder.lineNumber >= lines.length ||
        lines[reminder.lineNumber] !== reminder.rawLine
      ) {
        // Line has moved or changed, try to find it by content hash
        let foundLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(reminder.content)) {
            foundLine = i;
            break;
          }
        }
        if (foundLine === -1) {
          throw new Error(
            `Cannot find reminder line in ${reminder.filePath}. The file may have been modified.`
          );
        }
        reminder.lineNumber = foundLine;
      }

      // Build the updated line
      const newContent = updates.content ?? reminder.content;
      // Use 'in' check to distinguish "not provided" from "explicitly cleared to undefined"
      const newDueDate = 'dueDate' in updates
        ? updates.dueDate
        : currentDueDate;
      const newPriority = updates.priority ?? reminder.priority;
      const storedDates = buildStoredReminderDates(newDueDate, newHasTime);
      // Apply optimistic update immediately (UI updates)
      index.applyOptimisticUpdate(reminder.id, {
        content: newContent,
        dueDate: storedDates.dueDate,
        dueDatetime: storedDates.dueDatetime,
        priority: newPriority,
        recurrence: newRecurrence,
      });

      // Preserve indentation from original line
      const indentMatch = reminder.rawLine.match(/^(\s*)/);
      const indentation = indentMatch ? indentMatch[1] : "";

      const newLine = rebuildCheckboxLine(
        indentation,
        reminder.completed,
        newContent,
        newDueDate,
        newPriority,
        undefined,  // project (not used in line)
        newRecurrence,
        newHasTime,
      );

      // Replace the line
      lines[reminder.lineNumber] = newLine;

      try {
        // Write back to file (fast)
        await app.vault.modify(file, lines.join("\n"));
        log.info(`Updated reminder in ${reminder.filePath} at line ${reminder.lineNumber}`);

        // Force index rescan (clears optimistic state with real data)
        if (onFileWritten) {
          await onFileWritten(file);
        }

        // Fire CalDAV sync in background (don't await)
        if (onReminderChange) {
          const contentHash = generateContentHash(newContent);
          const updatedReminder: Reminder & { contentHash: string } = {
            id: reminder.id,
            content: newContent,
            dueDate: storedDates.dueDate,
            dueDatetime: storedDates.dueDatetime,
            priority: newPriority,
            completed: reminder.completed,
            project: newProject || 'Inbox',
            recurrence: newRecurrence,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contentHash,
          };
          onReminderChange(updatedReminder, 'update').catch(err => {
            log.error('Sync failed for update', err);
          });
        }
      } catch (error) {
        // Rollback optimistic state on file write failure
        index.clearOptimistic(reminder.id);
        throw error;
      }
    },

    async deleteReminder(reminder: IndexedReminder): Promise<void> {
      const file = await getFile(reminder.filePath);
      if (!file) {
        throw new Error(`File not found: ${reminder.filePath}`);
      }

      // Apply optimistic delete immediately (UI updates)
      index.applyOptimisticDelete(reminder.id);

      const fileContent = await app.vault.read(file);
      const lines = fileContent.split("\n");

      // Verify and find the line
      let lineToDelete = reminder.lineNumber;
      if (
        lineToDelete >= lines.length ||
        lines[lineToDelete] !== reminder.rawLine
      ) {
        // Try to find by content
        let foundLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(reminder.content)) {
            foundLine = i;
            break;
          }
        }
        if (foundLine === -1) {
          log.warn(
            ` Reminder line not found, may already be deleted`
          );
          // Clear optimistic state since item doesn't exist
          index.clearOptimistic(reminder.id);
          return;
        }
        lineToDelete = foundLine;
      }

      // Remove the line
      lines.splice(lineToDelete, 1);

      try {
        // Write back to file (fast)
        await app.vault.modify(file, lines.join("\n"));
        log.info(`Deleted reminder from ${reminder.filePath} at line ${lineToDelete}`);

        // Force index rescan (clears optimistic state with real data)
        if (onFileWritten) {
          await onFileWritten(file);
        }

        // Fire CalDAV sync in background (don't await)
        if (onReminderChange) {
          onReminderChange(toReminder(reminder), 'delete').catch(err => {
            log.error('Sync failed for delete', err);
          });
        }
      } catch (error) {
        // Rollback optimistic state on file write failure
        index.clearOptimistic(reminder.id);
        throw error;
      }
    },

    async toggleComplete(reminder: IndexedReminder): Promise<void> {
      const file = await getFile(reminder.filePath);
      if (!file) {
        throw new Error(`File not found: ${reminder.filePath}`);
      }

      // Calculate optimistic state before file operations
      let newCompleted = !reminder.completed;
      let newDueDatetime = reminder.dueDatetime;
      let newDueDate = reminder.dueDate;
      let context: ReminderChangeContext | undefined;
      const currentDue = parseStoredReminderDate(reminder) ?? new Date();
      const currentHasTime = reminderHasTime(reminder) ?? false;
      const recurrence = normalizeRecurrenceRule(reminder.recurrence);

      // For recurring reminders that are being completed, calculate next occurrence
      if (!reminder.completed && recurrence) {
        const nextDue = calculateNextOccurrence(currentDue, recurrence);
        if (nextDue) {
          newCompleted = false; // Stays uncompleted
          const storedDates = buildStoredReminderDates(nextDue, currentHasTime);
          newDueDatetime = storedDates.dueDatetime;
          newDueDate = storedDates.dueDate;

          // Pass context about the completed instance for CalDAV sync
          context = {
            recurringInstanceCompleted: {
              completedDate: currentDue.toISOString(),
              nextDate: nextDue.toISOString(),
            },
          };
        }
      }

      // Apply optimistic update immediately (UI updates)
      index.applyOptimisticUpdate(reminder.id, {
        completed: newCompleted,
        dueDate: newDueDate,
        dueDatetime: newDueDatetime,
      });

      const fileContent = await app.vault.read(file);
      const lines = fileContent.split("\n");

      // Find the line
      let lineNumber = reminder.lineNumber;
      if (
        lineNumber >= lines.length ||
        lines[lineNumber] !== reminder.rawLine
      ) {
        // Try to find by content
        let foundLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(reminder.content)) {
            foundLine = i;
            break;
          }
        }
        if (foundLine === -1) {
          // Rollback optimistic state
          index.clearOptimistic(reminder.id);
          throw new Error(
            `Cannot find reminder line in ${reminder.filePath}`
          );
        }
        lineNumber = foundLine;
      }

      const line = lines[lineNumber];
      let newLine: string;

      if (reminder.completed) {
        // Uncompleting: [x] -> [ ]
        newLine = line.replace(/\[x\]/i, "[ ]");
      } else {
        // Completing - check for recurrence
        if (recurrence) {
          // Calculate next occurrence
          const nextDue = calculateNextOccurrence(currentDue, recurrence);

          if (nextDue) {
            // Has next occurrence - rebuild line with new date, keep unchecked
            // Extract indentation from original line
            const indentMatch = line.match(/^(\s*)/);
            const indentation = indentMatch ? indentMatch[1] : '';

            newLine = rebuildCheckboxLine(
              indentation,
              false,  // Keep unchecked
              reminder.content,
              nextDue,
              reminder.priority,
              reminder.project,
              recurrence,
              currentHasTime,
            );

            log.info(`Recurring reminder: advancing to next occurrence ${nextDue.toISOString()}`);
          } else {
            // No more occurrences (end date reached) - mark complete normally
            newLine = line.replace(/\[ \]/, "[x]");
            log.info(`Recurring reminder: no more occurrences, marking complete`);
          }
        } else {
          // Non-recurring - mark complete normally
          newLine = line.replace(/\[ \]/, "[x]");
        }
      }

      lines[lineNumber] = newLine;

      try {
        // Write back to file (fast)
        await app.vault.modify(file, lines.join("\n"));

        // Immediately trigger index rescan (bypasses VaultWatcher debounce)
        if (onFileWritten) {
          await onFileWritten(file);
        }

        log.info(
          `Toggled completion for reminder in ${reminder.filePath} at line ${lineNumber}`
        );

        // Fire CalDAV sync in background (don't await)
        if (onReminderChange) {
          const contentHash = generateContentHash(reminder.content);
          const updatedReminder: Reminder & { contentHash: string } = {
            id: reminder.id,
            content: reminder.content,
            completed: newCompleted,
            completedAt: newCompleted ? new Date().toISOString() : undefined,
            priority: reminder.priority,
            project: reminder.project || 'Inbox',
            dueDate: newDueDate,
            dueDatetime: newDueDatetime,
            recurrence,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contentHash,
          };
          onReminderChange(updatedReminder, 'update', context).catch(err => {
            log.error('Sync failed for toggle', err);
          });
        }
      } catch (error) {
        // Rollback optimistic state on file write failure
        index.clearOptimistic(reminder.id);
        throw error;
      }
    },

    setOnReminderChange(callback: OnReminderChangeCallback): void {
      onReminderChange = callback;
    },

    setOnFileWritten(callback: OnFileWrittenCallback): void {
      onFileWritten = callback;
    },
  };
}
