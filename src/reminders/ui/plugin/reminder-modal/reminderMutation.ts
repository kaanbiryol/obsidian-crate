import type { CreateReminderParams, Priority, Reminder, RecurrenceRule } from '../../../types';
import { resolveReminderSubmission } from '../../../core/reminderSubmission';

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

export type NewReminder = Pick<CreateReminderParams, 'content' | 'description' | 'project' | 'priority' | 'recurrence' | 'dueDate' | 'dueDatetime'>;

export interface ReminderSubmission {
	content: string;
	description?: string;
	project: string;
	priority: Priority;
	dueDate?: string;
	hasTime?: boolean;
	recurrence?: RecurrenceRule;
	newReminder?: NewReminder;
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
	const resolved = resolveReminderSubmission({
		content, description, projects, priority, project, dueDate, hasTime, recurrence,
		mode: reminder ? 'edit' : 'create', originalDueDatetime: reminder?.dueDatetime,
	});
	if (!resolved) return null;

	const submission: ReminderSubmission = {
		content: resolved.content,
		description: resolved.description,
		project: resolved.project,
		priority: resolved.priority,
		dueDate: resolved.dueDateValue,
		hasTime: resolved.hasTime,
		recurrence: resolved.recurrence,
	};

	const fields = {
		content: resolved.content,
		description: resolved.description,
		project: resolved.project,
		priority: resolved.priority,
		dueDatetime: resolved.dueDatetime,
		dueDate: resolved.dueDate,
		recurrence: resolved.recurrence,
	};
	if (reminder) submission.updatedReminder = { ...reminder, ...fields };
	else submission.newReminder = fields;

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
