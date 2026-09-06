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
} from "./types";

export type {
  MarkdownWriter,
} from "./types";

export function createMarkdownWriter(
  app: App,
  index: ReminderIndex,
): MarkdownWriter {
  let onFileWritten: OnFileWrittenCallback | undefined;
  let mutationQueue: Promise<void> = Promise.resolve();

  const enqueueMutation = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const context: MarkdownWriterContext = {
    app,
    index,
    getFile: (filePath: string) => getFile(app, filePath),
    getOrCreateProjectFile: (project: string) => getOrCreateProjectFile(app, index, project),
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
    ) => enqueueMutation(() =>
      createReminderInMarkdown(
        context,
        project,
        content,
        dueDate,
        priority,
        recurrence,
        hasTime,
        reminderId,
        description,
      )
    ),
    updateReminder: (reminder, updates) =>
      enqueueMutation(() => updateReminderInMarkdown(context, reminder, updates)),
    deleteReminder: (reminder) =>
      enqueueMutation(() => deleteReminderInMarkdown(context, reminder)),
    toggleComplete: (reminder) =>
      enqueueMutation(() => toggleReminderCompletionInMarkdown(context, reminder)),
    reorderReminders: (filePath, orderedIds) =>
      enqueueMutation(() => reorderRemindersInMarkdown(context, filePath, orderedIds)),
    setOnFileWritten(callback: OnFileWrittenCallback): void {
      onFileWritten = callback;
    },
  };
}
