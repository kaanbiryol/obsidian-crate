import {
  calculateFirstOccurrence,
  calculateNextOccurrence,
  createLogger,
  generateContentHash,
  type Priority,
  type Reminder,
  type RecurrenceRule,
} from "@/reminders";
import { rebuildCheckboxLine } from "@/reminders/utils/checkboxParser";
import {
  buildStoredReminderDates,
  inferHasTimeFromDate,
  parseStoredReminderDate,
  reminderHasTime,
} from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import {
  createReminderId,
  setReminderIdMarker,
} from "./reminderIdentity";
import type { IndexedReminder } from "./reminderIndex";
import {
  findReminderLineNumber,
  toReminder,
} from "./markdownWriterHelpers";
import {
  appendReminderBlockToContent,
  buildDescriptionBlock,
  deleteReminderBlockFromContent,
  replaceReminderBlockInContent,
  reorderReminderBlocksInContent,
} from "./markdownReminderFile";
import type {
  MarkdownWriterContext,
  ReminderChangeContext,
  UpdateReminderInput,
} from "./markdownWriterTypes";

const log = createLogger("MarkdownWriter");

async function notifyFileWritten(
  context: MarkdownWriterContext,
  file: Awaited<ReturnType<MarkdownWriterContext["getFile"]>>,
): Promise<void> {
  const onFileWritten = context.getOnFileWritten();
  if (onFileWritten && file) {
    await onFileWritten(file);
  }
}

function triggerReminderChange(
  context: MarkdownWriterContext,
  reminder: Reminder,
  operation: "create" | "update" | "delete",
  changeContext?: ReminderChangeContext,
): void {
  const onReminderChange = context.getOnReminderChange();
  if (!onReminderChange) return;

  onReminderChange(reminder, operation, changeContext).catch((error) => {
    log.error(`Sync failed for ${operation}`, error);
  });
}

export async function createReminderInMarkdown(
  context: MarkdownWriterContext,
  project: string,
  content: string,
  dueDate: Date | undefined,
  priority: Priority,
  recurrence?: RecurrenceRule,
  hasTime?: boolean,
  reminderId?: string,
  description?: string,
): Promise<void> {
  const normalizedRecurrence = normalizeRecurrenceRule(recurrence);
  const stableReminderId = reminderId ?? createReminderId();
  const file = await context.getOrCreateProjectFile(project);
  const fileContent = await context.app.vault.read(file);

  let effectiveDueDate = dueDate;
  if (normalizedRecurrence && !dueDate) {
    effectiveDueDate = calculateFirstOccurrence(normalizedRecurrence);
  }
  const resolvedHasTime = hasTime ?? inferHasTimeFromDate(effectiveDueDate);
  const storedDates = buildStoredReminderDates(effectiveDueDate, resolvedHasTime);

  const newLine = rebuildCheckboxLine(
    "",
    false,
    content,
    effectiveDueDate,
    priority,
    undefined,
    normalizedRecurrence,
    resolvedHasTime,
    stableReminderId,
  );

  const contentHash = generateContentHash(content);
  const normalizedDescription = description?.trim() || undefined;
  const optimisticReminder: IndexedReminder = {
    id: stableReminderId,
    content,
    description: normalizedDescription,
    dueDate: storedDates.dueDate,
    dueDatetime: storedDates.dueDatetime,
    priority,
    completed: false,
    project,
    recurrence: normalizedRecurrence,
    filePath: file.path,
    lineNumber: -1,
    rawLine: newLine,
    contentHash,
  };

  context.index.applyOptimisticCreate(optimisticReminder);

  const newContent = appendReminderBlockToContent(
    fileContent,
    newLine,
    normalizedDescription,
  );

  try {
    await context.app.vault.modify(file, newContent);
    log.info(`Created reminder in ${file.path}`);
    await notifyFileWritten(context, file);

    const reminder: Reminder & { contentHash: string } = {
      id: stableReminderId,
      content,
      dueDate: storedDates.dueDate,
      dueDatetime: storedDates.dueDatetime,
      priority,
      completed: false,
      project,
      recurrence: normalizedRecurrence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contentHash,
    };
    triggerReminderChange(context, reminder, "create");
  } catch (error) {
    context.index.clearOptimistic(stableReminderId);
    throw error;
  }
}

export async function updateReminderInMarkdown(
  context: MarkdownWriterContext,
  reminder: IndexedReminder,
  updates: UpdateReminderInput,
): Promise<void> {
  const newProject = updates.project ?? reminder.project;
  const oldProject = reminder.project || "Inbox";
  const newRecurrence = Object.prototype.hasOwnProperty.call(updates, "recurrence")
    ? normalizeRecurrenceRule(updates.recurrence ?? undefined)
    : normalizeRecurrenceRule(reminder.recurrence);
  const currentDueDate = parseStoredReminderDate(reminder);
  const currentHasTime = reminderHasTime(reminder);
  const newHasTime = Object.prototype.hasOwnProperty.call(updates, "hasTime")
    ? updates.hasTime
    : ("dueDate" in updates ? inferHasTimeFromDate(updates.dueDate) : currentHasTime);

  if (newProject && newProject !== oldProject) {
    log.info(`Moving reminder from ${oldProject} to ${newProject}`);
    const newContent = updates.content ?? reminder.content;
    const newDueDate = "dueDate" in updates ? updates.dueDate : currentDueDate;
    const newPriority = updates.priority ?? reminder.priority;
    const movedDescription = "description" in updates
      ? updates.description
      : reminder.description;

    await deleteReminderInMarkdown(context, reminder);
    await createReminderInMarkdown(
      context,
      newProject,
      newContent,
      newDueDate,
      newPriority,
      newRecurrence,
      newHasTime,
      reminder.id,
      movedDescription,
    );
    return;
  }

  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
  }

  const fileContent = await context.app.vault.read(file);
  const lines = fileContent.split("\n");
  const lineNumber = findReminderLineNumber(lines, reminder);
  if (lineNumber === -1) {
    throw new Error(
      `Cannot safely locate reminder line in ${reminder.filePath}. The file may have been modified.`,
    );
  }

  const newContent = updates.content ?? reminder.content;
  const newDueDate = "dueDate" in updates ? updates.dueDate : currentDueDate;
  const newPriority = updates.priority ?? reminder.priority;
  const storedDates = buildStoredReminderDates(newDueDate, newHasTime);
  const newDescription = "description" in updates
    ? (updates.description?.trim() || undefined)
    : reminder.description;
  const newDescLines = buildDescriptionBlock(newDescription);

  context.index.applyOptimisticUpdate(reminder.id, {
    content: newContent,
    description: newDescription,
    dueDate: storedDates.dueDate,
    dueDatetime: storedDates.dueDatetime,
    priority: newPriority,
    recurrence: newRecurrence,
  });

  const indentMatch = reminder.rawLine.match(/^(\s*)/);
  const indentation = indentMatch ? indentMatch[1] : "";
  const newLine = rebuildCheckboxLine(
    indentation,
    reminder.completed,
    newContent,
    newDueDate,
    newPriority,
    undefined,
    newRecurrence,
    newHasTime,
    reminder.id,
  );

  const replacement = replaceReminderBlockInContent(
    fileContent,
    reminder,
    [newLine, ...newDescLines],
  );

  try {
    await context.app.vault.modify(file, replacement.content);
    log.info(`Updated reminder in ${reminder.filePath} at line ${replacement.lineNumber}`);
    await notifyFileWritten(context, file);

    const contentHash = generateContentHash(newContent);
    const updatedReminder: Reminder & { contentHash: string } = {
      id: reminder.id,
      content: newContent,
      dueDate: storedDates.dueDate,
      dueDatetime: storedDates.dueDatetime,
      priority: newPriority,
      completed: reminder.completed,
      project: newProject || "Inbox",
      recurrence: newRecurrence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contentHash,
    };
    triggerReminderChange(context, updatedReminder, "update");
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}

export async function deleteReminderInMarkdown(
  context: MarkdownWriterContext,
  reminder: IndexedReminder,
): Promise<void> {
  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
  }

  context.index.applyOptimisticDelete(reminder.id);

  const fileContent = await context.app.vault.read(file);
  const deletion = deleteReminderBlockFromContent(fileContent, reminder);
  if (!deletion.found) {
    log.warn(" Reminder line not found, may already be deleted");
    context.index.clearOptimistic(reminder.id);
    return;
  }

  try {
    await context.app.vault.modify(file, deletion.content);
    log.info(`Deleted reminder from ${reminder.filePath} at line ${deletion.lineNumber}`);
    await notifyFileWritten(context, file);
    triggerReminderChange(context, toReminder(reminder), "delete");
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}

export async function toggleReminderCompletionInMarkdown(
  context: MarkdownWriterContext,
  reminder: IndexedReminder,
): Promise<void> {
  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
  }

  let newCompleted = !reminder.completed;
  let newDueDatetime = reminder.dueDatetime;
  let newDueDate = reminder.dueDate;
  let changeContext: ReminderChangeContext | undefined;
  const currentDue = parseStoredReminderDate(reminder) ?? new Date();
  const currentHasTime = reminderHasTime(reminder) ?? false;
  const recurrence = normalizeRecurrenceRule(reminder.recurrence);

  if (!reminder.completed && recurrence) {
    const nextDue = calculateNextOccurrence(currentDue, recurrence);
    if (nextDue) {
      newCompleted = false;
      const storedDates = buildStoredReminderDates(nextDue, currentHasTime);
      newDueDatetime = storedDates.dueDatetime;
      newDueDate = storedDates.dueDate;
      changeContext = {
        recurringInstanceCompleted: {
          completedDate: currentDue.toISOString(),
          nextDate: nextDue.toISOString(),
        },
      };
    }
  }

  context.index.applyOptimisticUpdate(reminder.id, {
    completed: newCompleted,
    dueDate: newDueDate,
    dueDatetime: newDueDatetime,
  });

  const fileContent = await context.app.vault.read(file);
  const lines = fileContent.split("\n");
  const lineNumber = findReminderLineNumber(lines, reminder);
  if (lineNumber === -1) {
    context.index.clearOptimistic(reminder.id);
    throw new Error(`Cannot safely locate reminder line in ${reminder.filePath}`);
  }

  const line = lines[lineNumber];
  let newLine: string;

  if (reminder.completed) {
    newLine = line.replace(/\[x\]/i, "[ ]");
  } else if (recurrence) {
    const nextDue = calculateNextOccurrence(currentDue, recurrence);

    if (nextDue) {
      const indentMatch = line.match(/^(\s*)/);
      const indentation = indentMatch ? indentMatch[1] : "";
      newLine = rebuildCheckboxLine(
        indentation,
        false,
        reminder.content,
        nextDue,
        reminder.priority,
        reminder.project,
        recurrence,
        currentHasTime,
        reminder.id,
      );
      log.info(`Recurring reminder: advancing to next occurrence ${nextDue.toISOString()}`);
    } else {
      newLine = line.replace(/\[ \]/, "[x]");
      log.info("Recurring reminder: no more occurrences, marking complete");
    }
  } else {
    newLine = line.replace(/\[ \]/, "[x]");
  }

  lines[lineNumber] = setReminderIdMarker(newLine, reminder.id);

  try {
    await context.app.vault.modify(file, lines.join("\n"));
    await notifyFileWritten(context, file);
    log.info(`Toggled completion for reminder in ${reminder.filePath} at line ${lineNumber}`);

    const contentHash = generateContentHash(reminder.content);
    const updatedReminder: Reminder & { contentHash: string } = {
      id: reminder.id,
      content: reminder.content,
      completed: newCompleted,
      completedAt: newCompleted ? new Date().toISOString() : undefined,
      priority: reminder.priority,
      project: reminder.project || "Inbox",
      dueDate: newDueDate,
      dueDatetime: newDueDatetime,
      recurrence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contentHash,
    };
    triggerReminderChange(context, updatedReminder, "update", changeContext);
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}

export async function reorderRemindersInMarkdown(
  context: MarkdownWriterContext,
  filePath: string,
  orderedIds: string[],
): Promise<void> {
  const file = await context.getFile(filePath);
  if (!file) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileContent = await context.app.vault.read(file);
  await context.app.vault.modify(file, reorderReminderBlocksInContent(fileContent, orderedIds));
  log.info(`Reordered reminders in ${filePath}`);
}
