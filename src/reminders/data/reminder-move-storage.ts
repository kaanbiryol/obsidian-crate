import type { DataAdapter } from 'obsidian';
import { extractReminderId } from '../core/reminderIdentity';
import { decodeDescriptionFromMarkdown } from '../core/markdownReminderFile';

export interface ReminderMoveRecord {
	version: 1;
	operationId: string;
	folderPath: string;
	id: string;
	source: { filePath: string; block: string };
	destination: { filePath: string; block: string };
}

function validateRecord(value: unknown): ReminderMoveRecord {
	if (!value || typeof value !== 'object') throw new Error('Invalid reminder move recovery record');
	const record = value as ReminderMoveRecord;
	const safePath = (path: unknown): path is string => typeof path === 'string' && !!path
		&& !/[\\\0]/.test(path) && path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
	if (record.version !== 1 || !/^[\da-f-]{36}$/i.test(record.operationId) || !safePath(record.folderPath)
		|| typeof record.id !== 'string' || !record.id) throw new Error('Invalid reminder move recovery record');
	for (const side of [record.source, record.destination]) {
		if (!side || !safePath(side.filePath) || !side.filePath.startsWith(`${record.folderPath}/`) || !side.filePath.endsWith('.md')
			|| typeof side.block !== 'string' || side.block.length > 1024 * 1024) throw new Error('Invalid reminder move recovery path or block');
		const lines = side.block.split('\n');
		if (lines.length > 2 || extractReminderId(lines[0]!) !== record.id) throw new Error('Invalid reminder move recovery identity');
		if (lines[1]) {
			if (!lines[1].startsWith('<!-- crate-desc:') || !lines[1].endsWith(' -->')) throw new Error('Invalid reminder move recovery description');
			decodeDescriptionFromMarkdown(lines[1].slice('<!-- crate-desc:'.length, -4));
		}
	}
	if (record.source.filePath === record.destination.filePath) throw new Error('Invalid reminder move recovery destination');
	return record;
}

export function createReminderMoveStorage(adapter: DataAdapter, directory: string) {
	const pathFor = (id: string) => `${directory}/${id}.json`;
	return {
		async read(): Promise<ReminderMoveRecord[]> {
			if (!await adapter.exists(directory)) return [];
			const listing = await adapter.list(directory);
			const records: ReminderMoveRecord[] = [];
			for (const path of listing.files.filter(path => path.endsWith('.json')).sort()) {
				const record = validateRecord(JSON.parse(await adapter.read(path)));
				if (path !== pathFor(record.operationId)) throw new Error('Reminder move recovery filename mismatch');
				records.push(record);
			}
			return records;
		},
		async write(record: ReminderMoveRecord): Promise<void> {
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
		async remove(record: ReminderMoveRecord): Promise<void> {
			const path = pathFor(record.operationId);
			await adapter.remove(path);
			if (await adapter.exists(path)) throw new Error('Could not clear reminder move recovery record');
		},
	};
}
