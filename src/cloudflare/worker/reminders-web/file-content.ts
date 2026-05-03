import { calculateFirstOccurrence, calculateNextOccurrence } from '@/reminders/utils/recurrenceCalculator';
import { rebuildCheckboxLine, parseCheckboxLine } from '@/reminders/utils/checkboxParser';
import {
	buildStoredReminderDates,
	inferHasTimeFromDate,
	parseStoredReminderDate,
	reminderHasTime,
} from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import type { buildReminderUpdate } from '@/reminders/data/storageCompatShared';
import { extractReminderId, setReminderIdMarker } from '@/reminders/data/reminderIdentity';
import type { RemoteReminderRecord } from './types';

function countDescriptionBlockLines(lines: string[], checkboxLineNumber: number): number {
	const nextIndex = checkboxLineNumber + 1;
	if (nextIndex >= lines.length || !lines[nextIndex].startsWith('<!-- crate-desc:')) {
		return 0;
	}

	for (let index = nextIndex; index < lines.length; index++) {
		if (lines[index].includes('-->')) {
			return index - nextIndex + 1;
		}
	}

	return 0;
}

function buildDescriptionBlock(description: string | undefined): string[] {
	if (!description?.trim()) return [];
	return [`<!-- crate-desc:${description.trim()} -->`];
}

function recurrenceKey(value: RecurrenceRule | undefined): string {
	return JSON.stringify(normalizeRecurrenceRule(value) ?? null);
}

function lineMatchesReminder(line: string, reminder: RemoteReminderRecord): boolean {
	const parsed = parseCheckboxLine(line);
	if (!parsed) {
		return false;
	}

	const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
	return parsed.parsed.cleanContent === reminder.content
		&& parsed.isCompleted === reminder.completed
		&& parsed.parsed.priority === reminder.priority
		&& storedDates.dueDate === reminder.dueDate
		&& storedDates.dueDatetime === reminder.dueDatetime
		&& recurrenceKey(parsed.parsed.recurrence) === recurrenceKey(reminder.recurrence);
}

function findReminderLineNumber(lines: string[], reminder: RemoteReminderRecord): number {
	if (
		reminder.lineNumber >= 0
		&& reminder.lineNumber < lines.length
		&& lines[reminder.lineNumber] === reminder.rawLine
	) {
		return reminder.lineNumber;
	}

	for (let index = 0; index < lines.length; index++) {
		if (extractReminderId(lines[index]) === reminder.id) {
			return index;
		}
	}

	const exactMatches: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (lines[index] === reminder.rawLine) {
			exactMatches.push(index);
		}
	}
	if (exactMatches.length === 1) {
		return exactMatches[0];
	}

	const semanticMatches: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (lineMatchesReminder(lines[index], reminder)) {
			semanticMatches.push(index);
		}
	}
	if (semanticMatches.length === 1) {
		return semanticMatches[0];
	}

	return -1;
}

export function getProjectFilePath(folderPath: string, project: string): string {
	return `${folderPath}/${project}.md`;
}

export function getInitialProjectFileContent(project: string): string {
	const projectName = project.split('/').pop() || project;
	return `# ${projectName}\n\n`;
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
	const descriptionLines = buildDescriptionBlock(params.description?.trim() || undefined);
	const trimmed = fileContent.trimEnd();
	const separator = trimmed.match(/^#[^\n]*$/) ? '\n\n' : '\n';
	const block = descriptionLines.length > 0
		? `${newLine}\n${descriptionLines.join('\n')}`
		: newLine;
	return `${trimmed}${separator}${block}\n`;
}

export function deleteReminderFromFileContent(fileContent: string, reminder: RemoteReminderRecord): string {
	const lines = fileContent.split('\n');
	const lineToDelete = findReminderLineNumber(lines, reminder);
	if (lineToDelete === -1) {
		return fileContent;
	}

	const descCount = countDescriptionBlockLines(lines, lineToDelete);
	lines.splice(lineToDelete, 1 + descCount);
	return lines.join('\n');
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

	const oldDescCount = countDescriptionBlockLines(lines, lineNumber);
	lines.splice(lineNumber, 1 + oldDescCount, newLine, ...newDescLines);
	return lines.join('\n');
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
	const lines = fileContent.split('\n');

	interface FileSegment {
		isBlock: boolean;
		lines: string[];
		id?: string | null;
		isCompleted?: boolean;
	}

	const segments: FileSegment[] = [];
	let index = 0;
	let nonBlockAccum: string[] = [];

	while (index < lines.length) {
		const parsed = parseCheckboxLine(lines[index]);
		if (parsed) {
			if (nonBlockAccum.length > 0) {
				segments.push({ isBlock: false, lines: [...nonBlockAccum] });
				nonBlockAccum = [];
			}

			const blockLines = [lines[index]];
			const descCount = countDescriptionBlockLines(lines, index);
			for (let descIndex = 1; descIndex <= descCount; descIndex++) {
				blockLines.push(lines[index + descIndex]);
			}

			segments.push({
				isBlock: true,
				lines: blockLines,
				id: extractReminderId(lines[index]),
				isCompleted: parsed.isCompleted,
			});
			index += 1 + descCount;
		} else {
			nonBlockAccum.push(lines[index]);
			index++;
		}
	}

	if (nonBlockAccum.length > 0) {
		segments.push({ isBlock: false, lines: nonBlockAccum });
	}

	const allBlockSegments = segments.filter((segment) => segment.isBlock);
	const activeBlocks = allBlockSegments.filter((segment) => !segment.isCompleted);
	const completedBlocks = allBlockSegments.filter((segment) => segment.isCompleted);

	const activeById = new Map(activeBlocks.map((block) => [block.id, block]));
	const reorderedActive: FileSegment[] = [];
	for (const id of orderedIds) {
		const block = activeById.get(id);
		if (block) {
			reorderedActive.push(block);
			activeById.delete(id);
		}
	}

	for (const block of activeBlocks) {
		if (block.id !== null && activeById.has(block.id)) {
			reorderedActive.push(block);
		} else if (block.id === null) {
			reorderedActive.push(block);
		}
	}

	const reorderedBlocks = [...reorderedActive, ...completedBlocks];
	let blockIndex = 0;
	const result: string[] = [];
	for (const segment of segments) {
		if (segment.isBlock) {
			if (blockIndex < reorderedBlocks.length) {
				result.push(...reorderedBlocks[blockIndex].lines);
				blockIndex++;
			}
		} else {
			result.push(...segment.lines);
		}
	}

	return result.join('\n');
}
