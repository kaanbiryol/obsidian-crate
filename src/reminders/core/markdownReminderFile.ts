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
	description?: string;
}

export interface FileContentMutationResult {
	content: string;
	lineNumber: number;
	found: boolean;
}

const DESCRIPTION_ENCODING_PREFIX = "v1:";

export function encodeDescriptionForMarkdown(description: string): string {
	return `${DESCRIPTION_ENCODING_PREFIX}${encodeURIComponent(description.trim()).replace(/-/g, "%2D")}`;
}

export function decodeDescriptionFromMarkdown(description: string): string {
	const trimmed = description.trim();
	if (!trimmed.startsWith(DESCRIPTION_ENCODING_PREFIX)) throw new Error('Unsupported reminder description encoding');
	return decodeURIComponent(trimmed.slice(DESCRIPTION_ENCODING_PREFIX.length));
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

	for (const [index, line] of lines.entries()) {
		if (extractReminderId(line) === reminder.id) {
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
		return exactMatches[0] ?? -1;
	}

	const semanticMatches: number[] = [];
	for (const [index, line] of lines.entries()) {
		if (lineMatchesReminder(line, reminder)) {
			semanticMatches.push(index);
		}
	}
	if (semanticMatches.length === 1) {
		return semanticMatches[0] ?? -1;
	}

	return -1;
}

export function getInitialProjectFileContent(project: string): string {
	const projectName = project.split("/").pop() || project;
	return `# ${projectName}\n\n`;
}

export function buildDescriptionBlock(description: string | undefined): string[] {
	if (!description?.trim()) return [];
	return [`<!-- crate-desc:${encodeDescriptionForMarkdown(description)} -->`];
}

function countDescriptionBlockLines(
	lines: string[],
	checkboxLineNumber: number,
): number {
	const nextIndex = checkboxLineNumber + 1;
	const nextLine = lines[nextIndex];
	if (!nextLine?.startsWith("<!-- crate-desc:")) return 0;

	if (!nextLine.endsWith(' -->')) throw new Error('Invalid reminder description block');
	decodeDescriptionFromMarkdown(nextLine.slice('<!-- crate-desc:'.length, -4));
	return 1;
}

export function assertReminderBlockUnchanged(lines: string[], reminder: ReminderLineRecord, lineNumber: number): void {
	const line = lines[lineNumber];
	const count = countDescriptionBlockLines(lines, lineNumber);
	const block = lines.slice(lineNumber + 1, lineNumber + 1 + count).join('\n');
	const description = block
		? decodeDescriptionFromMarkdown(block.slice('<!-- crate-desc:'.length, block.indexOf('-->')))
		: '';
	if (!line || (line !== reminder.rawLine && !lineMatchesReminder(line, reminder)) || description !== (reminder.description?.trim() ?? '')) {
		throw new Error('Reminder changed while it was being edited. Reload it before saving; your changes were not applied');
	}
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
	assertReminderBlockUnchanged(lines, reminder, lineNumber);

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
	assertReminderBlockUnchanged(lines, reminder, lineNumber);

	const descCount = countDescriptionBlockLines(lines, lineNumber);
	lines.splice(lineNumber, 1 + descCount);
	return {
		content: lines.join("\n"),
		lineNumber,
		found: true,
	};
}

export class ReminderReorderConflictError extends Error {}

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
		const line = lines[index];
		if (line === undefined) break;
		const parsed = parseCheckboxLine(line);
		if (parsed) {
			if (nonBlockAccum.length > 0) {
				segments.push({ isBlock: false, lines: [...nonBlockAccum] });
				nonBlockAccum = [];
			}

			const blockLines = [line];
			const descCount = countDescriptionBlockLines(lines, index);
			for (let descIndex = 1; descIndex <= descCount; descIndex++) {
				const descriptionLine = lines[index + descIndex];
				if (descriptionLine !== undefined) blockLines.push(descriptionLine);
			}

			segments.push({
				isBlock: true,
				lines: blockLines,
				id: extractReminderId(line),
				isCompleted: parsed.isCompleted,
			});
			index += 1 + descCount;
		} else {
			nonBlockAccum.push(line);
			index++;
		}
	}

	if (nonBlockAccum.length > 0) {
		segments.push({ isBlock: false, lines: nonBlockAccum });
	}

	const allBlockSegments = segments.filter((segment) => segment.isBlock);
	const blocksById = new Map<string, FileSegment>();
	for (const block of allBlockSegments) {
		if (!block.id) continue;
		if (blocksById.has(block.id)) {
			throw new ReminderReorderConflictError('Duplicate reminder identifiers. Refresh the project before reordering; nothing was changed.');
		}
		blocksById.set(block.id, block);
	}

	const requestedIds = new Set<string>();
	const requestedBlocks: FileSegment[] = [];
	for (const id of orderedIds) {
		const block = blocksById.get(id);
		if (requestedIds.has(id) || !block || block.isCompleted) {
			throw new ReminderReorderConflictError('Reminder order changed. Refresh the project before reordering; nothing was changed.');
		}
		requestedIds.add(id);
		requestedBlocks.push(block);
	}

	// Only replace slots owned by this request. Concurrently added, unindexed,
	// and completed blocks retain their current content and position.
	let requestedIndex = 0;
	const reorderedBlocks = allBlockSegments.map(block => {
		if (!block.id || !requestedIds.has(block.id)) return block;
		const replacement = requestedBlocks[requestedIndex++];
		if (!replacement) throw new ReminderReorderConflictError('Cannot safely reorder these reminders; nothing was changed.');
		return replacement;
	});

	// Every source block must be emitted exactly once, including blocks that
	// were absent from the caller's index. Check before returning any new bytes.
	if (reorderedBlocks.length !== allBlockSegments.length
		|| new Set(reorderedBlocks).size !== allBlockSegments.length) {
		throw new ReminderReorderConflictError('Cannot safely reorder these reminders; nothing was changed.');
	}
	let blockIndex = 0;
	const result: string[] = [];
	for (const segment of segments) {
		if (segment.isBlock) {
			const reorderedBlock = reorderedBlocks[blockIndex];
			if (reorderedBlock) {
				result.push(...reorderedBlock.lines);
				blockIndex++;
			}
		} else {
			result.push(...segment.lines);
		}
	}

	return result.join("\n");
}
