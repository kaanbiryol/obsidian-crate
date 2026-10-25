import { reminderRevision } from '../../core/reminderRevision';
import React, { useMemo, useRef } from "react";
import { Notice } from "obsidian";
import { AddReminderModal as SharedAddReminderModal } from "@/reminders/ui/plugin/reminder-modal/AddReminderModal";
import type { NewReminder } from "@/reminders/ui/plugin/reminder-modal/reminderMutation";
import { createLogger } from "@/reminders/logger";
import { DEFAULT_PROJECT, projectOptionsWithDefault } from '../../core/constants';
import { ReminderInputError } from '../../core/reminderMutationInput';

const log = createLogger('ReminderModal');

import { today } from "@/reminders/core/dates/time";
import { type DueDateDefaultSetting, useRemindersSettingsStore } from "@/reminders/settings";
import { ModalContext, PluginContext } from "@/reminders/ui/plugin/reminders-context";
import { requireReminderBackend } from "@/reminders/runtime";
import type { Reminder } from "@/reminders/types/reminder";
import { useObsidianKeyboardHeight } from "@/ui/plugin/hooks/useObsidianKeyboardHeight";

type ReminderModalProps = {
  initialProject?: string;
  reminder?: Reminder;
  onSave?: (reminder: Reminder | null) => void;
  onDelete?: (reminder: Reminder) => void;
};

const calculateDefaultDueDate = (setting: DueDateDefaultSetting): string | undefined => {
  switch (setting) {
    case "none":
      return undefined;
    case "today":
      return today().toString();
    case "tomorrow":
      return today().add({ days: 1 }).toString();
  }
};

export const ReminderModal: React.FC<ReminderModalProps> = ({
  initialProject = DEFAULT_PROJECT,
  reminder,
  onSave,
  onDelete,
}) => {
  const plugin = PluginContext.use();
  const createId = useRef(crypto.randomUUID());
  const settings = useRemindersSettingsStore();
  const modal = ModalContext.use();
  const { isMobile } = modal;

  // Track keyboard height on mobile to position modal above keyboard
  const keyboardHeight = useObsidianKeyboardHeight(isMobile);

  // Get projects and active reminders from index (sync, fast)
  const projects = plugin.reminders?.repository.getProjects() ?? [];
  const projectsList = projectOptionsWithDefault(projects);

  // Calculate default due date
  const defaultDueDate = useMemo(() => {
    if (reminder) return undefined;
    return calculateDefaultDueDate(settings.taskCreationDefaultDueDate);
  }, [reminder, settings.taskCreationDefaultDueDate]);

  const handleAdd = async (newReminder: NewReminder) => {
    try {
      await requireReminderBackend(plugin).repository.create({ id: createId.current, ...newReminder });

      new Notice("Reminder created!");
      if (onSave) onSave(null); // Trigger refresh
    } catch (err) {
      new Notice(err instanceof Error ? err.message : "Failed to create reminder");
      log.error("Failed to create reminder", err);
      throw err;
    }
  };

  const handleSave = async (updatedReminder: Reminder) => {
    try {
      const saved = await requireReminderBackend(plugin).repository.update(updatedReminder.id, {
        expectedRevision: reminder ? await reminderRevision(reminder) : undefined,
        content: updatedReminder.content,
        description: updatedReminder.description,
        priority: updatedReminder.priority,
        project: updatedReminder.project,
        dueDate: updatedReminder.dueDate,
        dueDatetime: updatedReminder.dueDatetime,
        recurrence: updatedReminder.recurrence ?? null,
      });
      if (!saved) {
        throw new Error(`Reminder not found: ${updatedReminder.id}`);
      }

      new Notice("Reminder updated!");
      onSave?.(saved);
    } catch (err) {
      new Notice(err instanceof ReminderInputError ? err.message : "Failed to update reminder");
      log.error("Failed to update reminder", err);
      throw err;
    }
  };

  const handleDelete = async (reminderToDelete: Reminder) => {
    // Shared modal handles confirmation
    log.info(" Deleting reminder:", reminderToDelete?.id);

    try {
      const deleted = await requireReminderBackend(plugin).repository.delete(reminderToDelete.id, await reminderRevision(reminderToDelete));
      if (!deleted) {
        new Notice("Reminder not found");
        log.warn(" Reminder not found:", reminderToDelete.id);
        throw new Error("Reminder no longer exists. Refresh to continue.");
      }

      new Notice("Reminder deleted");
      onDelete?.(reminderToDelete);
    } catch (err) {
      new Notice("Failed to delete reminder");
      log.error("Failed to delete reminder", err);
      throw err;
    }
  };

  // Mobile uses a bottom sheet; desktop uses a centered modal.
  return (
    <SharedAddReminderModal
      onClose={() => modal.close()}
      onAdd={handleAdd}
      onSave={handleSave}
      onDelete={handleDelete}
      reminder={reminder}
      projects={projectsList}
      defaultProject={initialProject}
      initialDueDate={defaultDueDate}
      variant={isMobile ? "bottom-sheet" : "centered"}
      keyboardOffset={keyboardHeight}
    />
  );
};
