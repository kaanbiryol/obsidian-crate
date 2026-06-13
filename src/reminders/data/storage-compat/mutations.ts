import { createReminderId } from "../../core/reminderIdentity";
import { buildCreatedReminderFallback, buildCreateReminderArgs, buildReminderUpdate, toReminder } from "./shared";
import type { StorageCompatContext } from "./types";
import type { CreateReminderParams, Reminder, UpdateReminderParams } from "@/reminders/types/plugin-reminder";

export function createStorageCompatMutations({ index, writer }: StorageCompatContext) {
  return {
    async create(params: CreateReminderParams) {
      const createArgs = buildCreateReminderArgs(params);
      const reminderId = createArgs.reminderId || createReminderId();

      await writer.createReminder(
        createArgs.project,
        params.content,
        createArgs.dueDate,
        createArgs.priority,
        createArgs.recurrence,
        createArgs.hasTime,
        reminderId,
        params.description,
      );

      const createdReminder = index.getById(reminderId);
      if (createdReminder) {
        return toReminder(createdReminder);
      }

      return buildCreatedReminderFallback({
        id: reminderId,
        content: params.content,
        description: params.description,
        project: createArgs.project,
        priority: createArgs.priority,
        recurrence: createArgs.recurrence,
        storedDates: createArgs.storedDates,
      });
    },

    async update(id: string, params: UpdateReminderParams) {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      const update = buildReminderUpdate(params);
      await writer.updateReminder(indexed, update.updates);

      const updated: Omit<Reminder, "recurrence"> & {
        recurrence?: Reminder["recurrence"] | null;
      } = {
        ...toReminder(indexed),
        ...params,
        ...(update.hasRecurrenceUpdate ? { recurrence: update.recurrenceUpdate } : {}),
        ...update.storedDates,
        updatedAt: new Date().toISOString(),
      };

      if (updated.recurrence === null) {
        updated.recurrence = undefined;
      }

      return updated as Reminder;
    },

    async delete(id: string) {
      const indexed = index.getById(id);
      if (!indexed) return false;

      await writer.deleteReminder(indexed);
      return true;
    },

    async complete(id: string) {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      await writer.toggleComplete(indexed);
      return {
        ...toReminder(indexed),
        completed: true,
        completedAt: new Date().toISOString(),
      };
    },

    async uncomplete(id: string) {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      await writer.toggleComplete(indexed);
      return {
        ...toReminder(indexed),
        completed: false,
        completedAt: undefined,
      };
    },

    async reorder(project: string, orderedIds: string[]) {
      const filePath = `${index.remindersFolderPath}/${project}.md`;
      await writer.reorderReminders(filePath, orderedIds);
    },

    async forceSave() {
      return undefined;
    },
  };
}
