import type { Priority, Reminder, RecurrenceRule } from '../../types';
import { parseReminderContent } from '../../utils/reminderParser';
import {
	buildStoredReminderDates,
	parseReminderDateValue,
	serializeReminderDateValue,
} from '../../utils/reminderDate';
import { normalizeRecurrenceRule } from '../../utils/recurrenceRule';

export interface ReminderSubmissionInput {
	content: string;
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
	project: string;
	priority: Priority;
	dueDate?: string;
	hasTime?: boolean;
	recurrence?: RecurrenceRule;
	updatedReminder?: Reminder;
}

interface ExecuteReminderActionOptions {
	optimistic: boolean;
	close: () => void;
	action: () => Promise<void>;
	onError?: (error: Error) => void;
	delayMs?: number;
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

	const parsed = parseReminderContent(content, projects);
	const finalContent = parsed.cleanContent?.trim() || content.trim();
	if (!finalContent) {
		return null;
	}

	const finalPriority = parsed.priorityPart ? parsed.priority : priority;
	const finalProject = parsed.project || project;
	const finalDueDate = parsed.dueDate
		? serializeReminderDateValue(parsed.dueDate, parsed.hasTime)
		: dueDate ?? undefined;
	const finalHasTime = parsed.dueDate ? (parsed.hasTime ?? false) : (hasTime ?? false);
	const finalRecurrence = normalizeRecurrenceRule(parsed.recurrence || recurrence);
	const storedDates = buildStoredReminderDates(
		parseReminderDateValue(finalDueDate, finalHasTime),
		finalHasTime,
	);

	const submission: ReminderSubmission = {
		content: finalContent,
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
			project: finalProject,
			priority: finalPriority,
			dueDatetime: storedDates.dueDatetime,
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

	if (options.optimistic) {
		options.beforeClose?.();
		options.close();
		window.setTimeout(() => {
			void run();
		}, options.delayMs ?? 0);
		return;
	}

	const succeeded = await run();
	if (succeeded) {
		options.close();
	}
}
