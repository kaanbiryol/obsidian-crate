import type { Priority, RecurrenceRule } from "@/reminders/types/reminder";
import { parseCheckboxLine } from "@/reminders/utils/checkboxParser";
import { buildStoredReminderDates } from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import { extractReminderId } from "./reminderIdentity";

export interface ReminderLineRecord {
	id: string;
	content: string;
	dueDate?: string;
	dueDatetime?: string;
	priority: Priority;
	completed: boolean;
	recurrence?: RecurrenceRule;
	lineNumber: number;
	rawLine: string;
}

export interface FileContentMutationResult {
	content: string;
	lineNumber: number;
	found: boolean;
}

function recurrenceKey(value: RecurrenceRule | undefined): string {
	return JSON.stringify(normalizeRecurrenceRule(value) ?? null);
}

function lineMatchesReminder(line: string, reminder: ReminderLineRecord): boolean {
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

export function findReminderLineNumber(lines: string[], reminder: ReminderLineRecord): number {
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

export function getInitialProjectFileContent(project: string): string {
	const projectName = project.split("/").pop() || project;
	return `# ${projectName}\n\n`;
}

export function buildDescriptionBlock(description: string | undefined): string[] {
	if (!description?.trim()) return [];
	return [`<!-- crate-desc:${description.trim()} -->`];
}

export function countDescriptionBlockLines(
	lines: string[],
	checkboxLineNumber: number,
): number {
	const nextIndex = checkboxLineNumber + 1;
	if (nextIndex >= lines.length || !lines[nextIndex].startsWith("<!-- crate-desc:")) return 0;

	for (let index = nextIndex; index < lines.length; index++) {
		if (lines[index].includes("-->")) return index - nextIndex + 1;
	}

	return 0;
}

export function appendReminderBlockToContent(
	fileContent: string,
	checkboxLine: string,
	description: string | undefined,
): string {
	const descriptionLines = buildDescriptionBlock(description?.trim() || undefined);
	const trimmed = fileContent.trimEnd();
	const separator = trimmed.match(/^#[^\n]*$/) ? "\n\n" : "\n";
	const block = descriptionLines.length > 0
		? `${checkboxLine}\n${descriptionLines.join("\n")}`
		: checkboxLine;
	return `${trimmed}${separator}${block}\n`;
}

export function replaceReminderBlockInContent(
	fileContent: string,
	reminder: ReminderLineRecord,
	replacementLines: string[],
): FileContentMutationResult {
	const lines = fileContent.split("\n");
	const lineNumber = findReminderLineNumber(lines, reminder);
	if (lineNumber === -1) {
		return { content: fileContent, lineNumber, found: false };
	}

	const oldDescCount = countDescriptionBlockLines(lines, lineNumber);
	lines.splice(lineNumber, 1 + oldDescCount, ...replacementLines);
	return {
		content: lines.join("\n"),
		lineNumber,
		found: true,
	};
}

export function deleteReminderBlockFromContent(
	fileContent: string,
	reminder: ReminderLineRecord,
): FileContentMutationResult {
	const lines = fileContent.split("\n");
	const lineNumber = findReminderLineNumber(lines, reminder);
	if (lineNumber === -1) {
		return { content: fileContent, lineNumber, found: false };
	}

	const descCount = countDescriptionBlockLines(lines, lineNumber);
	lines.splice(lineNumber, 1 + descCount);
	return {
		content: lines.join("\n"),
		lineNumber,
		found: true,
	};
}

export function reorderReminderBlocksInContent(fileContent: string, orderedIds: string[]): string {
	const lines = fileContent.split("\n");

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

	return result.join("\n");
}
