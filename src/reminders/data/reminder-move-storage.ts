import type { DataAdapter } from 'obsidian';
import { extractReminderId } from '../core/reminderIdentity';
import { readDescriptionBlock } from '../core/reminderDescription';
import { isMarkdownNoteInFolder, isMarkdownPath } from '@/protocol/note-paths';
import { isReminderArchivePath, isReminderNotePath } from '@/protocol/reminder-archive-path';
import type { ArchivedReminderBlock } from '../core/reminder-archive';

export interface ReminderMoveRecord {
	version: 1;
	kind?: undefined;
	operationId: string;
	folderPath: string;
	id: string;
	source: { filePath: string; block: string };
	destination: { filePath: string; block: string };
}

/** Completed reminders moving from a project note to its archive note in one run. */
export interface ReminderArchiveRecord {
	version: 1;
	kind: 'archive';
	operationId: string;
	folderPath: string;
	source: { filePath: string };
	destination: { filePath: string };
	blocks: ArchivedReminderBlock[];
}

export type ReminderJournalRecord = ReminderMoveRecord | ReminderArchiveRecord;

const MAX_BLOCK_BYTES = 1024 * 1024;
const safePath = (path: unknown): path is string => typeof path === 'string' && !!path
	&& !/[\\\0]/.test(path) && path.split('/').every(segment => segment && segment !== '.' && segment !== '..');

function validateBlock(id: unknown, block: unknown, error: string): void {
	if (typeof id !== 'string' || !id || typeof block !== 'string' || block.length > MAX_BLOCK_BYTES) throw new Error(error);
	const lines = block.split('\n');
	if (extractReminderId(lines[0]!) !== id) throw new Error('Invalid reminder move recovery identity');
	if (readDescriptionBlock(lines, 0).lineCount !== lines.length - 1) throw new Error('Invalid reminder move recovery description');
}

function validateArchiveRecord(record: ReminderArchiveRecord): ReminderArchiveRecord {
	if (!safePath(record.source?.filePath) || !isReminderNotePath(record.source.filePath, record.folderPath)
		|| !safePath(record.destination?.filePath) || !isMarkdownPath(record.destination.filePath)
		|| !isReminderArchivePath(record.destination.filePath, record.folderPath)
		|| !Array.isArray(record.blocks) || !record.blocks.length) throw new Error('Invalid reminder archive recovery path or blocks');
	const ids = new Set<string>();
	for (const entry of record.blocks) {
		validateBlock(entry?.id, entry?.block, 'Invalid reminder archive recovery block');
		if (ids.has(entry.id)) throw new Error('Invalid reminder archive recovery identity');
		ids.add(entry.id);
	}
	return record;
}

function validateRecord(value: unknown): ReminderJournalRecord {
	if (!value || typeof value !== 'object') throw new Error('Invalid reminder move recovery record');
	const record = value as ReminderJournalRecord;
	if (record.version !== 1 || !/^[\da-f-]{36}$/i.test(record.operationId) || !safePath(record.folderPath)) throw new Error('Invalid reminder move recovery record');
	if (record.kind === 'archive') return validateArchiveRecord(record);
	if (record.kind !== undefined || typeof record.id !== 'string' || !record.id) throw new Error('Invalid reminder move recovery record');
	for (const side of [record.source, record.destination]) {
		if (!side || !safePath(side.filePath) || !isMarkdownNoteInFolder(side.filePath, record.folderPath)) throw new Error('Invalid reminder move recovery path or block');
		validateBlock(record.id, side.block, 'Invalid reminder move recovery path or block');
	}
	if (record.source.filePath === record.destination.filePath) throw new Error('Invalid reminder move recovery destination');
	return record;
}

export function createReminderMoveStorage(adapter: DataAdapter, directory: string) {
	const pathFor = (id: string) => `${directory}/${id}.json`;
	return {
		async read(): Promise<ReminderJournalRecord[]> {
			if (!await adapter.exists(directory)) return [];
			const listing = await adapter.list(directory);
			const records: ReminderJournalRecord[] = [];
			for (const path of listing.files.filter(path => path.endsWith('.json')).sort()) {
				const record = validateRecord(JSON.parse(await adapter.read(path)));
				if (path !== pathFor(record.operationId)) throw new Error('Reminder move recovery filename mismatch');
				records.push(record);
			}
			return records;
		},
		async write(record: ReminderJournalRecord): Promise<void> {
			validateRecord(record);
			if (!await adapter.exists(directory)) await adapter.mkdir(directory);
			const path = pathFor(record.operationId);
			const temporary = `${path}.tmp`;
			const bytes = JSON.stringify(record);
			await adapter.write(temporary, bytes);
			if (await adapter.read(temporary) !== bytes) throw new Error('Could not verify reminder move recovery record');
			// Unique final names make publication a rename without replacing an
			// existing checkpoint. No Markdown mutation precedes this boundary.
			await adapter.rename(temporary, path);
			if (await adapter.read(path) !== bytes) throw new Error('Could not publish reminder move recovery record');
		},
		async remove(record: ReminderJournalRecord): Promise<void> {
			const path = pathFor(record.operationId);
			await adapter.remove(path);
			if (await adapter.exists(path)) throw new Error('Could not clear reminder move recovery record');
		},
	};
}
