import {
  generateContentHash,
} from "@/reminders/utils/checkboxParser";
import type { Reminder } from "@/reminders/types/reminder";
import { calculateNextOccurrence } from "@/reminders/utils/recurrenceCalculator";
import { rebuildCheckboxLine } from "@/reminders/utils/checkboxParser";
import {
  buildStoredReminderDates,
  parseStoredReminderDate,
  reminderHasTime,
} from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import { setReminderIdMarker } from "../../core/reminderIdentity";
import type { IndexedReminder } from "../reminder-index";
import { findReminderLineNumber } from "./helpers";
import type {
  MarkdownWriterContext,
  ReminderChangeContext,
} from "./types";
import {
  markdownWriterLog,
  notifyFileWritten,
  triggerReminderChange,
} from "./operation-shared";

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

  try {
    let lineNumber = -1;
    let recurrenceLogMessage: string | undefined;
    await context.app.vault.process(file, (fileContent) => {
      const lines = fileContent.split("\n");
      lineNumber = findReminderLineNumber(lines, reminder);
      if (lineNumber === -1) {
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
          recurrenceLogMessage = `Recurring reminder: advancing to next occurrence ${nextDue.toISOString()}`;
        } else {
          newLine = line.replace(/\[ \]/, "[x]");
          recurrenceLogMessage = "Recurring reminder: no more occurrences, marking complete";
        }
      } else {
        newLine = line.replace(/\[ \]/, "[x]");
      }

      lines[lineNumber] = setReminderIdMarker(newLine, reminder.id);
      return lines.join("\n");
    });

    if (recurrenceLogMessage) {
      markdownWriterLog.info(recurrenceLogMessage);
    }
    await notifyFileWritten(context, file);
    markdownWriterLog.info(`Toggled completion for reminder in ${reminder.filePath} at line ${lineNumber}`);

    const contentHash = generateContentHash(reminder.content);
    const updatedReminder: Reminder & { contentHash: string } = {
      id: reminder.id,
      content: reminder.content,
      completed: newCompleted,
      priority: reminder.priority,
      project: reminder.project || "Inbox",
      dueDate: newDueDate,
      dueDatetime: newDueDatetime,
      recurrence,
      contentHash,
    };
    triggerReminderChange(context, updatedReminder, "update", changeContext);
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}
