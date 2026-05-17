import React, { useMemo } from "react";
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
  const settings = useRemindersSettingsStore();
  const modal = ModalContext.use();
  const { isMobile } = modal;

  // Track keyboard height on mobile to position modal above keyboard
  const keyboardHeight = useKeyboardHeight(isMobile);

  // Get projects and active reminders from index (sync, fast)
  const projects = plugin.storage.getProjects() || [];
  const projectsList = ['Inbox', ...projects.filter((p: string) => p !== 'Inbox')];

  // Calculate default due date
  const defaultDueDate = useMemo(() => {
    if (reminder) return undefined;
    return calculateDefaultDueDate(settings.taskCreationDefaultDueDate);
  }, [reminder, settings.taskCreationDefaultDueDate]);

  const handleAdd = async (content: string, project: string, priority: number, dueDate?: string, recurrence?: RecurrenceRule, hasTime?: boolean, description?: string) => {
    // Close modal immediately for better UX
    modal.close();

    // Parse due date
    const parsedDueDate = parseReminderDateValue(dueDate, hasTime);

    try {
      // Always use markdown writer (markdown-first is always enabled)
      await plugin.markdownWriter.createReminder(
        project,
        content.trim(),
        parsedDueDate,
        priority as 1 | 4,
        recurrence,
        hasTime,
        undefined,
        description,
      );

      // VaultWatcher will handle rescanning after file modify event

      new Notice("Reminder created!");
      if (onSave) onSave(null); // Trigger refresh
    } catch (err) {
      new Notice("Failed to create reminder");
      log.error("Failed to create reminder", err);
      if (onSave) onSave(null);
    }
  };

  const handleSave = async (updatedReminder: Reminder) => {
    // Close modal immediately
    modal.close();

    try {
      // Parse due date for markdown writer
      const parsedDueDate = updatedReminder.dueDatetime
        ? parseReminderDateValue(updatedReminder.dueDatetime, true)
        : parseReminderDateValue(updatedReminder.dueDate, false);

      // Use markdown writer directly (markdown-first is always enabled)
      const indexed = plugin.reminderIndex?.getById(updatedReminder.id);
      if (indexed) {
        await plugin.markdownWriter.updateReminder(indexed, {
          content: updatedReminder.content,
          description: updatedReminder.description,
          dueDate: parsedDueDate,
          priority: updatedReminder.priority,
          project: updatedReminder.project,
          recurrence: updatedReminder.recurrence,
          hasTime: !!updatedReminder.dueDatetime,
        });

        // VaultWatcher will handle rescanning after file modify event

        new Notice("Reminder updated!");
        if (onSave) onSave(null); // Trigger refresh
      } else {
        // Fallback to storage compatibility layer
        await plugin.storage.update(updatedReminder.id, {
          content: updatedReminder.content,
          description: updatedReminder.description,
          priority: updatedReminder.priority,
          project: updatedReminder.project,
          dueDate: updatedReminder.dueDate,
          dueDatetime: updatedReminder.dueDatetime,
          recurrence: updatedReminder.recurrence ?? null,
        });
        new Notice("Reminder updated!");

        if (onSave) {
          const saved = await plugin.storage.getByIdAsync(updatedReminder.id);
          onSave(saved || updatedReminder);
        }
      }
    } catch (err) {
      new Notice("Failed to update reminder");
      log.error("Failed to update reminder", err);
    }
  };

  const handleDelete = async (reminderToDelete: Reminder) => {
    // Shared modal handles confirmation
    modal.close();

    log.info(" handleDelete called for reminder:", reminderToDelete?.id, reminderToDelete?.content);

    try {
      // Use markdown writer directly (markdown-first is always enabled)
      const indexed = plugin.reminderIndex?.getById(reminderToDelete.id);
      if (indexed) {
        await plugin.markdownWriter.deleteReminder(indexed);

        // VaultWatcher will handle rescanning after file modify event

        new Notice("Reminder deleted");
        if (onDelete) onDelete(reminderToDelete);
      } else {
        // Fallback to storage compatibility layer
        const deleteResult = await plugin.storage.delete(reminderToDelete.id);
        log.info(" storage.delete result:", deleteResult);

        if (deleteResult) {
          new Notice("Reminder deleted");
        } else {
          new Notice("Reminder not found in storage");
          log.warn(" Reminder not found:", reminderToDelete.id);
        }

        if (onDelete) {
          log.info(" Calling onDelete callback");
          onDelete(reminderToDelete);
        }
      }
    } catch (err) {
      new Notice("Failed to delete reminder");
      log.error("Failed to delete reminder", err);
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
