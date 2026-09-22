import { preserveReminderInstant } from '../../utils/preserveReminderInstant';
import type { Priority, Reminder, RecurrenceRule } from '../../types';
import { parseReminderEditorContent } from '../../utils/reminderEditorParsing';
import {
	buildStoredReminderDates,
	parseReminderDateValue,
	serializeReminderDateValue,
} from '../../utils/reminderDate';
import { normalizeRecurrenceRule, preserveRecurrenceMetadata } from '../../utils/recurrenceRule';

export interface ReminderSubmissionInput {
	content: string;
	description?: string;
	projects: string[];
	priority: Priority;
	project: string;
	dueDate: string | null;
	hasTime?: boolean;
	recurrence?: RecurrenceRule;
	reminder?: Reminder;
}

export interface ReminderSubmission {
	content: string;
	description?: string;
	project: string;
	priority: Priority;
	dueDate?: string;
	hasTime?: boolean;
	recurrence?: RecurrenceRule;
	updatedReminder?: Reminder;
}

interface ExecuteReminderActionOptions {
	close: () => void;
	action: () => Promise<void>;
	onError?: (error: Error) => void;
	beforeClose?: () => void;
	beforeRun?: () => void;
	afterSuccess?: () => void;
	afterSettled?: () => void;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function buildReminderSubmission({
	content,
	description,
	projects,
	priority,
	project,
	dueDate,
	hasTime,
	recurrence,
	reminder,
}: ReminderSubmissionInput): ReminderSubmission | null {
	if (!content.trim()) {
		return null;
	}

	const parsed = parseReminderEditorContent(content, projects);
	if (parsed.dateError) throw new Error(parsed.dateError);
	const finalContent = parsed.cleanContent.trim();
	if (!finalContent) {
		return null;
	}

	const finalPriority = parsed.priorityPart ? parsed.priority : priority;
	const finalProject = parsed.project || project;
	const chosenRecurrence = preserveRecurrenceMetadata(parsed.recurrence, recurrence) || (parsed.dueDate ? undefined : recurrence);
  const finalRecurrence = normalizeRecurrenceRule(chosenRecurrence);
	// The draft clears its occurrence when a repeat rule changes. Do not restore
	// the original reminder's occurrence after that edit.
	const finalDueDate = finalRecurrence ? (reminder && chosenRecurrence === recurrence ? dueDate ?? undefined : undefined) : parsed.dueDate
		? serializeReminderDateValue(parsed.dueDate, parsed.hasTime)
		: dueDate ?? undefined;
	const finalHasTime = finalRecurrence ? Boolean(finalDueDate && hasTime) : parsed.dueDate ? (parsed.hasTime ?? false) : (hasTime ?? false);
	const storedDates = buildStoredReminderDates(
		parseReminderDateValue(finalDueDate, finalHasTime),
		finalHasTime,
	);

	const finalDescription = description?.trim() || undefined;

	const submission: ReminderSubmission = {
		content: finalContent,
		description: finalDescription,
		project: finalProject,
		priority: finalPriority,
		dueDate: finalDueDate,
		hasTime: finalHasTime,
		recurrence: finalRecurrence,
	};

	if (reminder) {
		submission.updatedReminder = {
			...reminder,
			content: finalContent,
			description: finalDescription,
			project: finalProject,
			priority: finalPriority,
			dueDatetime: preserveReminderInstant(storedDates.dueDatetime, reminder.dueDatetime, Boolean(parsed.dueDate)),
			dueDate: storedDates.dueDate,
			recurrence: finalRecurrence,
		};
	}

	return submission;
}

export async function executeReminderAction(options: ExecuteReminderActionOptions): Promise<void> {
	const run = async (): Promise<boolean> => {
		try {
			options.beforeRun?.();
			await options.action();
			options.afterSuccess?.();
			return true;
		} catch (error) {
			options.onError?.(toError(error));
			return false;
		} finally {
			options.afterSettled?.();
		}
	};

	const succeeded = await run();
	if (succeeded) {
		options.beforeClose?.();
		options.close();
	}
}
