import type { IndexedReminder } from "./reminderIndex";

export interface ReminderOptimisticState {
  mergeReminders(reminders: IndexedReminder[]): IndexedReminder[];
  getById(id: string, actual: IndexedReminder | undefined): IndexedReminder | undefined;
  clearFileState(filePath: string, persistedReminders: IndexedReminder[]): void;
  applyCreate(reminder: IndexedReminder): void;
  applyUpdate(id: string, updates: Partial<IndexedReminder>): void;
  applyDelete(id: string): void;
  clear(id: string): void;
}

export function createReminderOptimisticState(): ReminderOptimisticState {
  const createdReminders = new Map<string, IndexedReminder>();
  const updatedReminders = new Map<string, Partial<IndexedReminder>>();
  const deletedReminderIds = new Set<string>();

  return {
    mergeReminders(reminders: IndexedReminder[]) {
      const visibleReminders = reminders.filter((reminder) => !deletedReminderIds.has(reminder.id));
      const withUpdates = visibleReminders.map((reminder) => {
        const updates = updatedReminders.get(reminder.id);
        return updates ? { ...reminder, ...updates } : reminder;
      });

      return [...withUpdates, ...Array.from(createdReminders.values())];
    },

    getById(id: string, actual: IndexedReminder | undefined) {
      if (deletedReminderIds.has(id)) {
        return undefined;
      }

      const created = createdReminders.get(id);
      if (created) {
        return created;
      }

      if (!actual) {
        return undefined;
      }

      const updates = updatedReminders.get(id);
      return updates ? { ...actual, ...updates } : actual;
    },

    clearFileState(filePath: string, persistedReminders: IndexedReminder[]) {
      for (const reminder of persistedReminders) {
        updatedReminders.delete(reminder.id);
        deletedReminderIds.delete(reminder.id);
      }

      for (const [id, reminder] of createdReminders) {
        if (reminder.filePath === filePath) {
          createdReminders.delete(id);
        }
      }
    },

    applyCreate(reminder: IndexedReminder) {
      createdReminders.set(reminder.id, reminder);
    },

    applyUpdate(id: string, updates: Partial<IndexedReminder>) {
      updatedReminders.set(id, updates);
    },

    applyDelete(id: string) {
      deletedReminderIds.add(id);
    },

    clear(id: string) {
      createdReminders.delete(id);
      updatedReminders.delete(id);
      deletedReminderIds.delete(id);
    },
  };
}
