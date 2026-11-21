import { extractReminderId } from './reminderIdentity';
import { readDescriptionBlock } from './reminderDescription';
import { hasAttachedMarkdownContent, markdownTaskContexts } from './markdownTaskContext';

/** A completed reminder's checkbox line and description, exactly as its note stores them. */
export interface ArchivedReminderBlock {
	id: string;
	block: string;
}

export interface ReminderArchivePlan {
	blocks: ArchivedReminderBlock[];
	/** Completed reminders that stay: nested, with attached content, or without a single owner. */
	skipped: number;
}

const COMPLETED_TASK = /^[ \t]*-\s*\[[xX]\]/;
const withoutCarriageReturns = (text: string) => text.replace(/\r(?=\n|$)/g, '');

/** Each reminder line with exactly one owning checkbox, and where its block ends. */
function ownedBlocks(lines: readonly string[]): Map<string, { lineNumber: number; end: number; indentation: number } | null> {
	const owners = new Map<string, { lineNumber: number; end: number; indentation: number } | null>();
	const tasks = markdownTaskContexts(lines);
	for (const [lineNumber, line] of lines.entries()) {
		const id = extractReminderId(line);
		if (!id) continue;
		const task = tasks.get(lineNumber);
		if (!task || owners.has(id)) { owners.set(id, null); continue; }
		let end: number;
		try { end = lineNumber + 1 + readDescriptionBlock(lines, lineNumber).lineCount; }
		catch { owners.set(id, null); continue; }
		owners.set(id, { lineNumber, end, indentation: task.indentation });
	}
	return owners;
}

/** Completed top-level reminders that can leave the note without detaching anything. */
export function planReminderArchive(content: string): ReminderArchivePlan {
	const lines = content.split('\n');
	const blocks: ArchivedReminderBlock[] = [];
	let skipped = 0;
	const owners = ownedBlocks(lines);
	for (const lineNumber of markdownTaskContexts(lines).keys()) {
		const line = lines[lineNumber]!;
		if (!COMPLETED_TASK.test(line)) continue;
		const id = extractReminderId(line);
		const owner = id ? owners.get(id) : null;
		if (!id || !owner || owner.lineNumber !== lineNumber || owner.indentation > 0
			|| hasAttachedMarkdownContent(lines, lineNumber, owner.end)) {
			skipped++;
			continue;
		}
		blocks.push({ id, block: lines.slice(lineNumber, owner.end).join('\n') });
	}
	return { blocks, skipped };
}

/** Removes each block still stored as planned, in any line ending. Others stay where they are. */
export function removeArchivedBlocks(content: string, blocks: readonly ArchivedReminderBlock[]): { content: string; removed: string[] } {
	const lines = content.split('\n');
	const owners = ownedBlocks(lines);
	const ranges = blocks.flatMap(({ id, block }) => {
		const owner = owners.get(id);
		if (!owner || withoutCarriageReturns(lines.slice(owner.lineNumber, owner.end).join('\n')) !== withoutCarriageReturns(block)
			|| hasAttachedMarkdownContent(lines, owner.lineNumber, owner.end)) return [];
		return [{ id, ...owner }];
	}).sort((left, right) => right.lineNumber - left.lineNumber);
	for (const range of ranges) lines.splice(range.lineNumber, range.end - range.lineNumber);
	return { content: lines.join('\n'), removed: ranges.map(range => range.id).reverse() };
}

/** Whether the archive note holds this block, in any line ending. */
export function hasArchivedBlock(content: string, { id, block }: ArchivedReminderBlock): boolean {
	const lines = withoutCarriageReturns(content).split('\n');
	const owner = ownedBlocks(lines).get(id);
	return !!owner && lines.slice(owner.lineNumber, owner.end).join('\n') === withoutCarriageReturns(block);
}

/** Appends blocks in the archive's line ending, replacing an older copy of the same
 * reminder, which `replaced` returns. A copy that cannot be replaced safely keeps that
 * reminder out of the run. */
export function appendArchivedBlocks(content: string, blocks: readonly ArchivedReminderBlock[]): { content: string; appended: ArchivedReminderBlock[]; replaced: ArchivedReminderBlock[] } {
	const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split('\n');
	const owners = ownedBlocks(lines);
	const appended = blocks.filter(({ id }) => owners.get(id) !== null);
	const previous = appended.flatMap(({ id }) => {
		const owner = owners.get(id);
		return owner ? [{ id, block: lines.slice(owner.lineNumber, owner.end).join('\n') }] : [];
	});
	const replacement = removeArchivedBlocks(content, previous);
	const removed = new Set(replacement.removed);
	const kept = appended.filter(({ id }) => !owners.has(id) || removed.has(id));
	if (!kept.length) return { content, appended: [], replaced: [] };
	const text = kept.map(({ block }) => withoutCarriageReturns(block).split('\n').join(lineEnding)).join(lineEnding);
	const base = replacement.content;
	const separator = !base || base.endsWith('\n') ? '' : lineEnding;
	return { content: `${base}${separator}${text}${lineEnding}`, appended: kept, replaced: previous.filter(({ id }) => removed.has(id)) };
}
