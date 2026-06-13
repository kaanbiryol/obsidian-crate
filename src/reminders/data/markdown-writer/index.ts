/**
 * Markdown Writer - Writes reminders to markdown files
 *
 * Handles:
 * - Creating new reminders in project files (Reminders/{project}.md)
 * - Updating existing reminder lines
 * - Deleting reminder lines
 * - Toggling completion status
 */

import type { App } from "obsidian";
import type { ReminderIndex } from "../reminder-index";
import {
  getFile,
  getOrCreateProjectFile,
} from "./helpers";
import {
  createReminderInMarkdown,
  deleteReminderInMarkdown,
  reorderRemindersInMarkdown,
  toggleReminderCompletionInMarkdown,
  updateReminderInMarkdown,
} from "./operations";
import type {
  MarkdownWriter,
  MarkdownWriterContext,
  OnFileWrittenCallback,
  OnReminderChangeCallback,
} from "./types";

export type {
  MarkdownWriter,
} from "./types";

export function createMarkdownWriter(
  app: App,
  index: ReminderIndex,
): MarkdownWriter {
  let onReminderChange: OnReminderChangeCallback | undefined;
  let onFileWritten: OnFileWrittenCallback | undefined;

  const context: MarkdownWriterContext = {
    app,
    index,
    getFile: (filePath: string) => getFile(app, filePath),
    getOrCreateProjectFile: (project: string) => getOrCreateProjectFile(app, index, project),
    getOnReminderChange: () => onReminderChange,
    getOnFileWritten: () => onFileWritten,
  };

  return {
    createReminder: (
      project,
      content,
      dueDate,
      priority,
      recurrence,
      hasTime,
      reminderId,
      description,
    ) => createReminderInMarkdown(
      context,
      project,
      content,
      dueDate,
      priority,
      recurrence,
      hasTime,
      reminderId,
      description,
    ),
    updateReminder: (reminder, updates) =>
      updateReminderInMarkdown(context, reminder, updates),
    deleteReminder: (reminder) =>
      deleteReminderInMarkdown(context, reminder),
    toggleComplete: (reminder) =>
      toggleReminderCompletionInMarkdown(context, reminder),
    reorderReminders: (filePath, orderedIds) =>
      reorderRemindersInMarkdown(context, filePath, orderedIds),
    setOnReminderChange(callback: OnReminderChangeCallback): void {
      onReminderChange = callback;
    },
    setOnFileWritten(callback: OnFileWrittenCallback): void {
      onFileWritten = callback;
    },
  };
}
