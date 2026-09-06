import { reminderRevision } from '../../core/reminderRevision';
import React, { useMemo, useRef } from "react";
import { Notice } from "obsidian";
import { AddReminderModal as SharedAddReminderModal } from "@/reminders/ui/reminder-modal/AddReminderModal";
import type { RecurrenceRule } from "@/reminders/types/reminder";
import { createLogger } from "@/reminders/utils/logger";

const log = createLogger('ReminderModal');

import { today } from "@/reminders/utils/time";
import { parseReminderDateValue } from "@/reminders/utils/reminderDate";
import { type DueDateDefaultSetting, useRemindersSettingsStore } from "@/reminders/settings";
import { ModalContext, PluginContext } from "@/reminders/ui/reminders-context";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { useKeyboardHeight } from "@/reminders/ui/hooks/useKeyboardHeight";

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
  initialProject = "Inbox",
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
  const keyboardHeight = useKeyboardHeight(isMobile);

  // Get projects and active reminders from index (sync, fast)
  const projects = plugin.reminderRepository.getProjects();
  const projectsList = ['Inbox', ...projects.filter((p: string) => p !== 'Inbox')];

  // Calculate default due date
  const defaultDueDate = useMemo(() => {
    if (reminder) return undefined;
    return calculateDefaultDueDate(settings.taskCreationDefaultDueDate);
  }, [reminder, settings.taskCreationDefaultDueDate]);

  const handleAdd = async (content: string, project: string, priority: number, dueDate?: string, recurrence?: RecurrenceRule, hasTime?: boolean, description?: string) => {
    // Parse due date
    const parsedDueDate = parseReminderDateValue(dueDate, hasTime);

    try {
      await plugin.reminderRepository.create({
        id: createId.current,
        content: content.trim(),
        project,
        priority: priority as 1 | 4,
        recurrence,
        description,
        ...(hasTime && parsedDueDate
          ? { dueDatetime: parsedDueDate.toISOString() }
          : dueDate
            ? { dueDate }
            : {}),
      });

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
      const saved = await plugin.reminderRepository.update(updatedReminder.id, {
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
      new Notice("Failed to update reminder");
      log.error("Failed to update reminder", err);
      throw err;
    }
  };

  const handleDelete = async (reminderToDelete: Reminder) => {
    // Shared modal handles confirmation
    log.info(" Deleting reminder:", reminderToDelete?.id);

    try {
      const deleted = await plugin.reminderRepository.delete(reminderToDelete.id, await reminderRevision(reminderToDelete));
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

  // Render the shared AddReminderModal directly
  // On mobile: bottom-sheet with animations and backdrop
  // On desktop: centered modal without animations
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
      showBackdrop={isMobile}
      pickerMode={isMobile ? "replace" : "overlay"}
      keyboardOffset={keyboardHeight}
    />
  );
};
