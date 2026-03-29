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
import { generateReminderId } from "./reminderIdentity";

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
    recurrence: indexed.recurrence,
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
  updateFileLinks(oldPath: string, newPath: string): Promise<number>;

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
        const today = new Date().toISOString().split('T')[0];
        for (const reminder of index.getCompleted()) {
          const dueDate = reminder.dueDatetime || reminder.dueDate;
          if (dueDate?.startsWith(today)) {
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
      const filePath = `${index.remindersFolderPath}/${project}.md`;
      const reminderId = generateReminderId(filePath, params.content);
      const dueDate = params.dueDatetime
        ? new Date(params.dueDatetime)
        : params.dueDate
        ? new Date(params.dueDate)
        : undefined;
      const priority: Priority = params.priority ?? 4;

      await writer.createReminder(
        project,
        params.content,
        dueDate,
        priority,
        params.recurrence,
      );

      // VaultWatcher will handle rescanning after file modify event

      const createdReminder = index.getById(reminderId);
      if (createdReminder) {
        return toReminder(createdReminder);
      }

      return {
        id: reminderId,
        content: params.content,
        dueDate: params.dueDate,
        dueDatetime: params.dueDatetime,
        priority,
        completed: false,
        project,
        recurrence: params.recurrence,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },

    async update(id: string, params: UpdateReminderParams): Promise<Reminder | undefined> {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      const dueDate = params.dueDatetime
        ? new Date(params.dueDatetime)
        : params.dueDate
        ? new Date(params.dueDate)
        : undefined;

      await writer.updateReminder(indexed, {
        content: params.content,
        dueDate,
        priority: params.priority,
        project: params.project,
        ...(Object.prototype.hasOwnProperty.call(params, 'recurrence')
          ? { recurrence: params.recurrence ?? null }
          : {}),
      });

      // VaultWatcher will handle rescanning after file modify event

      // Return updated reminder (normalize recurrence)
      const updated = {
        ...toReminder(indexed),
        ...params,
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

    async updateFileLinks(_oldPath: string, _newPath: string): Promise<number> {
      // This would require updating markdown files directly
      // For now, return 0 as file links aren't used in markdown mode
      return 0;
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
