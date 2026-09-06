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
	const finalContent = parsed.cleanContent?.trim() || content.trim();
	if (!finalContent) {
		return null;
	}

	const finalPriority = parsed.priorityPart ? parsed.priority : priority;
	const finalProject = parsed.project || project;
	const chosenRecurrence = preserveRecurrenceMetadata(parsed.recurrence, recurrence) || (parsed.dueDate ? undefined : recurrence);
  const finalRecurrence = normalizeRecurrenceRule(chosenRecurrence);
	const finalDueDate = finalRecurrence ? (reminder && chosenRecurrence === recurrence ? reminder.dueDatetime || reminder.dueDate : undefined) : parsed.dueDate
		? serializeReminderDateValue(parsed.dueDate, parsed.hasTime)
		: dueDate ?? undefined;
	const finalHasTime = finalRecurrence ? Boolean(finalDueDate && reminder?.dueDatetime) : parsed.dueDate ? (parsed.hasTime ?? false) : (hasTime ?? false);
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
			dueDatetime: preserveReminderInstant(storedDates.dueDatetime, reminder.dueDatetime),
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
