/**
 * Storage Compatibility Layer
 *
 * Provides a backwards-compatible storage interface that wraps
 * ReminderIndex (for reads) and MarkdownWriter (for writes).
 *
 * This allows existing UI components to work without major changes.
 */

import type { ReminderIndex, IndexedReminder } from "./reminderIndex";
import type { MarkdownWriter } from "./markdownWriter";
import type { Reminder, CreateReminderParams, UpdateReminderParams, Priority } from "@/reminders/types/plugin-reminder";
import { createReminderId } from "./reminderIdentity";
import {
  buildStoredReminderDates,
  formatLocalDateKey,
  parseReminderDateValue,
} from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";

/**
 * Convert IndexedReminder to Reminder
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

/**
 * Storage compatibility interface
 */
export interface StorageCompat {
  // Query methods
  getAll(): Reminder[];
  getActive(): Reminder[];
  getCompleted(): Reminder[];
  getTodayReminders(includeCompleted?: boolean): Reminder[];
  getUpcoming(days?: number): Reminder[];
  getOverdue(): Reminder[];
  getByProject(project: string): Reminder[];
  getByFile(filePath: string): Reminder[];
  getById(id: string): Reminder | undefined;
  getByIdAsync(id: string): Promise<Reminder | undefined>;
  getProjects(): string[];

  // Mutation methods (async)
  create(params: CreateReminderParams): Promise<Reminder>;
  update(id: string, params: UpdateReminderParams): Promise<Reminder | undefined>;
  delete(id: string): Promise<boolean>;
  complete(id: string): Promise<Reminder | undefined>;
  uncomplete(id: string): Promise<Reminder | undefined>;

  // Utility methods
  forceSave(): Promise<void>;

  // Stats
  getStats(): { activeCount: number; completedCount: number; totalCount: number };
}

/**
 * Create a storage compatibility layer
 */
export function createStorageCompat(
  index: ReminderIndex,
  writer: MarkdownWriter
): StorageCompat {
  return {
    // Query methods
    getAll(): Reminder[] {
      return index.getAll().map(toReminder);
    },

    getActive(): Reminder[] {
      return index.getActive().map(toReminder);
    },

    getCompleted(): Reminder[] {
      return index.getCompleted().map(toReminder);
    },

    getTodayReminders(_includeCompleted?: boolean): Reminder[] {
      // Get today's reminders plus overdue reminders
      const todayReminders = index.getToday();
      const overdueReminders = index.getOverdue();
      // Combine and deduplicate by id
      const combined = new Map<string, IndexedReminder>();
      for (const r of [...todayReminders, ...overdueReminders]) {
        combined.set(r.id, r);
      }
      if (_includeCompleted) {
        const today = formatLocalDateKey(new Date());
        for (const reminder of index.getCompleted()) {
          const dueDate = reminder.dueDatetime
            ? formatLocalDateKey(new Date(reminder.dueDatetime))
            : reminder.dueDate;
          if (dueDate === today) {
            combined.set(reminder.id, reminder);
          }
        }
      }
      return Array.from(combined.values()).map(toReminder);
    },

    getUpcoming(days: number = 7): Reminder[] {
      return index.getUpcoming(days).map(toReminder);
    },

    getOverdue(): Reminder[] {
      return index.getOverdue().map(toReminder);
    },

    getByProject(project: string): Reminder[] {
      return index.getByProject(project).map(toReminder);
    },

    getByFile(filePath: string): Reminder[] {
      return index.getByFile(filePath).map(toReminder);
    },

    getById(id: string): Reminder | undefined {
      const indexed = index.getById(id);
      return indexed ? toReminder(indexed) : undefined;
    },

    async getByIdAsync(id: string): Promise<Reminder | undefined> {
      // Same as getById since index is always loaded
      const indexed = index.getById(id);
      return indexed ? toReminder(indexed) : undefined;
    },

    getProjects(): string[] {
      return index.getProjects();
    },

    // Mutation methods
    async create(params: CreateReminderParams): Promise<Reminder> {
      const project = params.project || 'Inbox';
      const reminderId = params.id?.trim() || createReminderId();
      const recurrence = normalizeRecurrenceRule(params.recurrence);
      const dueDate = parseReminderDateValue(
        params.dueDatetime ?? params.dueDate,
        !!params.dueDatetime,
      );
      const priority: Priority = params.priority ?? 4;
      const storedDates = buildStoredReminderDates(dueDate, params.dueDatetime ? true : undefined);

      await writer.createReminder(
        project,
        params.content,
        dueDate,
        priority,
        recurrence,
        params.dueDatetime ? true : params.dueDate ? false : undefined,
        reminderId,
      );

      // VaultWatcher will handle rescanning after file modify event

      const createdReminder = index.getById(reminderId);
      if (createdReminder) {
        return toReminder(createdReminder);
      }

      return {
        id: reminderId,
        content: params.content,
        dueDate: storedDates.dueDate,
        dueDatetime: storedDates.dueDatetime,
        priority,
        completed: false,
        project,
        recurrence,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },

    async update(id: string, params: UpdateReminderParams): Promise<Reminder | undefined> {
      const indexed = index.getById(id);
      if (!indexed) return undefined;
      const hasRecurrenceUpdate = Object.prototype.hasOwnProperty.call(params, 'recurrence');
      const recurrenceUpdate = hasRecurrenceUpdate
        ? (params.recurrence === null ? null : normalizeRecurrenceRule(params.recurrence))
        : undefined;

      const hasDueDateUpdate = Object.prototype.hasOwnProperty.call(params, 'dueDate')
        || Object.prototype.hasOwnProperty.call(params, 'dueDatetime');
      const dueDate = hasDueDateUpdate
        ? parseReminderDateValue(params.dueDatetime ?? params.dueDate, !!params.dueDatetime)
        : undefined;
      const storedDates = hasDueDateUpdate
        ? buildStoredReminderDates(dueDate, params.dueDatetime ? true : params.dueDate ? false : undefined)
        : {};

      const updates: Parameters<MarkdownWriter['updateReminder']>[1] = {
        content: params.content,
        priority: params.priority,
        project: params.project,
        ...(hasRecurrenceUpdate
          ? { recurrence: recurrenceUpdate }
          : {}),
      };
      if (hasDueDateUpdate) {
        updates.dueDate = dueDate;
        updates.hasTime = params.dueDatetime ? true : params.dueDate ? false : undefined;
      }

      await writer.updateReminder(indexed, updates);

      // VaultWatcher will handle rescanning after file modify event

      // Return updated reminder (normalize recurrence)
      const updated = {
        ...toReminder(indexed),
        ...params,
        ...(hasRecurrenceUpdate
          ? { recurrence: recurrenceUpdate }
          : {}),
        ...storedDates,
        updatedAt: new Date().toISOString(),
      };
      // Ensure recurrence is undefined instead of null
      if (updated.recurrence === null) {
        updated.recurrence = undefined;
      }
      return updated as Reminder;
    },

    async delete(id: string): Promise<boolean> {
      const indexed = index.getById(id);
      if (!indexed) return false;

      await writer.deleteReminder(indexed);

      // VaultWatcher will handle rescanning after file modify event

      return true;
    },

    async complete(id: string): Promise<Reminder | undefined> {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      await writer.toggleComplete(indexed);

      // VaultWatcher will handle rescanning after file modify event

      return {
        ...toReminder(indexed),
        completed: true,
        completedAt: new Date().toISOString(),
      };
    },

    async uncomplete(id: string): Promise<Reminder | undefined> {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      await writer.toggleComplete(indexed);

      // VaultWatcher will handle rescanning after file modify event

      return {
        ...toReminder(indexed),
        completed: false,
        completedAt: undefined,
      };
    },

    // Utility methods
    async forceSave(): Promise<void> {
      // No-op - markdown files are saved immediately
    },

    // Stats
    getStats() {
      const active = index.getActive();
      const completed = index.getCompleted();
      return {
        activeCount: active.length,
        completedCount: completed.length,
        totalCount: active.length + completed.length,
      };
    },
  };
}
