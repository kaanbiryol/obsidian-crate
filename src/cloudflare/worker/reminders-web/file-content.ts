import { calculateFirstOccurrence, calculateNextOccurrence } from '@/reminders/utils/recurrenceCalculator';
import { rebuildCheckboxLine } from '@/reminders/utils/checkboxParser';
import {
	inferHasTimeFromDate,
	parseStoredReminderDate,
	reminderHasTime,
} from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import type { buildReminderUpdate } from '@/reminders/data/storage-compat/shared';
import { setReminderIdMarker } from '@/reminders/data/reminderIdentity';
import {
	appendReminderBlockToContent,
	buildDescriptionBlock,
	deleteReminderBlockFromContent,
	findReminderLineNumber,
	replaceReminderBlockInContent,
	reorderReminderBlocksInContent,
} from '@/reminders/data/markdownReminderFile';
import type { RemoteReminderRecord } from './types';

export { getInitialProjectFileContent } from '@/reminders/data/markdownReminderFile';

export function getProjectFilePath(folderPath: string, project: string): string {
	return `${folderPath}/${project}.md`;
}

export function createReminderInFileContent(
	fileContent: string,
	params: {
		content: string;
		description?: string;
		dueDate: Date | undefined;
		priority: Priority;
		recurrence?: RecurrenceRule;
		hasTime?: boolean;
		reminderId: string;
	},
): string {
	const normalizedRecurrence = normalizeRecurrenceRule(params.recurrence);
	let effectiveDueDate = params.dueDate;
	if (normalizedRecurrence && !effectiveDueDate) {
		effectiveDueDate = calculateFirstOccurrence(normalizedRecurrence);
	}

	const resolvedHasTime = params.hasTime ?? inferHasTimeFromDate(effectiveDueDate);
	const newLine = rebuildCheckboxLine(
		'',
		false,
		params.content,
		effectiveDueDate,
		params.priority,
		undefined,
		normalizedRecurrence,
		resolvedHasTime,
		params.reminderId,
	);
	return appendReminderBlockToContent(
		fileContent,
		newLine,
		params.description?.trim() || undefined,
	);
}

export function deleteReminderFromFileContent(fileContent: string, reminder: RemoteReminderRecord): string {
	return deleteReminderBlockFromContent(fileContent, reminder).content;
}

export function updateReminderInFileContent(
	fileContent: string,
	reminder: RemoteReminderRecord,
	update: ReturnType<typeof buildReminderUpdate>,
): string {
	const lines = fileContent.split('\n');
	const lineNumber = findReminderLineNumber(lines, reminder);
	if (lineNumber === -1) {
		throw new Error(`Cannot safely locate reminder line in ${reminder.filePath}`);
	}

	const currentDueDate = parseStoredReminderDate(reminder);
	const currentHasTime = reminderHasTime(reminder);
	const newRecurrence = Object.prototype.hasOwnProperty.call(update.updates, 'recurrence')
		? normalizeRecurrenceRule(update.updates.recurrence ?? undefined)
		: normalizeRecurrenceRule(reminder.recurrence);
	const newHasTime = Object.prototype.hasOwnProperty.call(update.updates, 'hasTime')
		? update.updates.hasTime
		: ('dueDate' in update.updates ? inferHasTimeFromDate(update.updates.dueDate) : currentHasTime);
	const newContent = update.updates.content ?? reminder.content;
	const newDueDate = 'dueDate' in update.updates ? update.updates.dueDate : currentDueDate;
	const newPriority = update.updates.priority ?? reminder.priority;
	const newDescription = 'description' in update.updates
		? (update.updates.description?.trim() || undefined)
		: reminder.description;
	const newDescLines = buildDescriptionBlock(newDescription);
	const indentMatch = reminder.rawLine.match(/^(\s*)/);
	const indentation = indentMatch ? indentMatch[1] : '';
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

	return replaceReminderBlockInContent(
		fileContent,
		reminder,
		[newLine, ...newDescLines],
	).content;
}

export function setReminderCompletedInFileContent(
	fileContent: string,
	reminder: RemoteReminderRecord,
	completed: boolean,
): string {
	if (reminder.completed === completed) {
		return fileContent;
	}

	const lines = fileContent.split('\n');
	const lineNumber = findReminderLineNumber(lines, reminder);
	if (lineNumber === -1) {
		throw new Error(`Cannot safely locate reminder line in ${reminder.filePath}`);
	}

	const line = lines[lineNumber];
	const currentDue = parseStoredReminderDate(reminder) ?? new Date();
	const currentHasTime = reminderHasTime(reminder) ?? false;
	const recurrence = normalizeRecurrenceRule(reminder.recurrence);
	let newLine: string;

	if (!completed) {
		newLine = line.replace(/\[x\]/i, '[ ]');
	} else if (recurrence) {
		const nextDue = calculateNextOccurrence(currentDue, recurrence);
		if (nextDue) {
			const indentMatch = line.match(/^(\s*)/);
			const indentation = indentMatch ? indentMatch[1] : '';
			newLine = rebuildCheckboxLine(
				indentation,
				false,
				reminder.content,
				nextDue,
				reminder.priority,
				undefined,
				recurrence,
				currentHasTime,
				reminder.id,
			);
		} else {
			newLine = line.replace(/\[ \]/, '[x]');
		}
	} else {
		newLine = line.replace(/\[ \]/, '[x]');
	}

	lines[lineNumber] = setReminderIdMarker(newLine, reminder.id);
	return lines.join('\n');
}

export function reorderReminderBlocksInFileContent(fileContent: string, orderedIds: string[]): string {
	return reorderReminderBlocksInContent(fileContent, orderedIds);
}
