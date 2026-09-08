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
import type { ReminderMoveJournal } from '../reminder-move-journal';
import { getReminderProjectFilePath } from '../../core/reminderProjectPath';
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
  moveJournal?: ReminderMoveJournal,
): MarkdownWriter {
  let onFileWritten: OnFileWrittenCallback | undefined;
  let mutationQueue: Promise<void> = Promise.resolve();

  const enqueueMutation = <T>(mutation: () => Promise<T>, paths: string[] | (() => string[])): Promise<T> => {
    const guarded = () => { moveJournal?.assertWritable(typeof paths === 'function' ? paths() : paths); return mutation(); };
    const result = mutationQueue.then(guarded, guarded);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const context: MarkdownWriterContext = {
    app,
    index,
    moveJournal,
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
      ), () => [getReminderProjectFilePath(index.remindersFolderPath, project)]
    ),
    updateReminder: (reminder, updates) =>
      enqueueMutation(() => updateReminderInMarkdown(context, reminder, updates), () => [reminder.filePath,
        ...(updates.project ? [getReminderProjectFilePath(index.remindersFolderPath, updates.project)] : [])]),
    deleteReminder: (reminder) =>
      enqueueMutation(() => deleteReminderInMarkdown(context, reminder), [reminder.filePath]),
    toggleComplete: (reminder) =>
      enqueueMutation(() => toggleReminderCompletionInMarkdown(context, reminder), [reminder.filePath]),
    reorderReminders: (filePath, orderedIds) =>
      enqueueMutation(() => reorderRemindersInMarkdown(context, filePath, orderedIds), [filePath]),
    setOnFileWritten(callback: OnFileWrittenCallback): void {
      onFileWritten = callback;
    },
  };
}
