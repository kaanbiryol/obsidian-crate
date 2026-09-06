import { parseStoredReminderDate } from '@/reminders/utils/reminderDate';
import {
	buildReminderCompletionPlan,
	setReminderCompletionInContent,
	type ReminderCompletionMutation,
} from '../../core/markdownReminderMutation';
import type { IndexedReminder } from '../reminder-index';
import type { MarkdownWriterContext } from './types';
import {
	markdownWriterLog,
	notifyFileWritten,
} from './operation-shared';

export async function toggleReminderCompletionInMarkdown(
	context: MarkdownWriterContext,
	reminder: IndexedReminder,
): Promise<void> {
	const file = await context.getFile(reminder.filePath);
	if (!file) {
		throw new Error(`File not found: ${reminder.filePath}`);
	}

	const requestedCompleted = !reminder.completed;
	const currentDue = parseStoredReminderDate(reminder) ?? new Date();
	const planned = buildReminderCompletionPlan(reminder, requestedCompleted, reminder.rawLine, currentDue);
	context.index.applyOptimisticUpdate(reminder.id, {
		completed: planned.completed,
		dueDate: planned.dueDate,
		dueDatetime: planned.dueDatetime,
	});

	try {
		const resultHolder: { value?: ReminderCompletionMutation } = {};
		await context.app.vault.process(file, (fileContent) => {
			const result = setReminderCompletionInContent(fileContent, reminder, requestedCompleted, currentDue);
			resultHolder.value = result;
			return result.content;
		});
		const result = resultHolder.value;
		if (!result) throw new Error(`Reminder update did not complete for ${reminder.filePath}`);

		if (result.recurringInstanceCompleted) {
			markdownWriterLog.info(
				`Recurring reminder: advancing to next occurrence ${result.recurringInstanceCompleted.nextDate}`,
			);
		} else if (requestedCompleted && result.recurrence) {
			markdownWriterLog.info('Recurring reminder: no more occurrences, marking complete');
		}

		await notifyFileWritten(context, file);
		markdownWriterLog.info(
			`Toggled completion for reminder in ${reminder.filePath} at line ${result.lineNumber}`,
		);

	} catch (error) {
		context.index.clearOptimistic(reminder.id);
		throw error;
	}
}
