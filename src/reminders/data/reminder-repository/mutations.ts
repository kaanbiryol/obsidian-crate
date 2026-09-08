import { reminderRevision } from '../../core/reminderRevision';
import { createReminderId } from "../../core/reminderIdentity";
import { buildCreatedReminderFallback, buildCreateReminderArgs, buildReminderUpdate } from "./shared";
import type { ReminderRepositoryContext } from "./types";
import type { CreateReminderParams, UpdateReminderParams } from "@/reminders/types/plugin-reminder";
import { getReminderProjectFilePath } from "@/reminders/core/reminderProjectPath";
import { toReminder } from "../toReminder";

export function createReminderRepositoryMutations({ index, writer }: ReminderRepositoryContext) {
  const currentReminder = (id: string) => {
    const current = index.getById(id);
    return current ? toReminder(current) : undefined;
  };
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

      if (params.expectedRevision && params.expectedRevision !== await reminderRevision(toReminder(indexed))) throw new Error('Reminder changed while editing. Your draft was not saved.');
      const update = buildReminderUpdate(params);
      await writer.updateReminder(indexed, update.updates);

      return currentReminder(id);
    },

    async delete(id: string, expectedRevision?: string) {
      const indexed = index.getById(id);
      if (!indexed) return false;

      if (expectedRevision && expectedRevision !== await reminderRevision(toReminder(indexed))) throw new Error('Reminder changed while editing. Nothing was deleted.');
      await writer.deleteReminder(indexed);
      return true;
    },

    async complete(id: string) {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      if (!indexed.completed) {
        await writer.toggleComplete(indexed);
      }

      return currentReminder(id);
    },

    async uncomplete(id: string) {
      const indexed = index.getById(id);
      if (!indexed) return undefined;

      if (indexed.completed) {
        await writer.toggleComplete(indexed);
      }

      return currentReminder(id);
    },

    async reorder(project: string, orderedIds: string[]) {
      const filePath = getReminderProjectFilePath(index.remindersFolderPath, project);
      await writer.reorderReminders(filePath, orderedIds);
    },
  };
}
