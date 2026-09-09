import { TFile, type App } from 'obsidian';
import { extractReminderId } from '../core/reminderIdentity';
import { buildDescriptionBlock } from '../core/markdownReminderFile';
import { hasAttachedMarkdownContent, markdownTaskContexts } from '../core/markdownTaskContext';
import { createReminderMoveStorage, type ReminderMoveRecord } from './reminder-move-storage';
import { portablePathKey } from '@/protocol/portable-path';
import { readVaultMarkdown, processVaultMarkdown } from './vault-markdown';

type MoveSide = ReminderMoveRecord['source'];
type ObservedBlock = { state: 'absent' | 'changed' | 'exact' | 'ambiguous'; lineNumber?: number; file: TFile | null; version: string | null };
const fileVersion = (file: TFile | null) => file ? `${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}` : null;

function observeContent(content: string, side: MoveSide, id: string): Omit<ObservedBlock, 'file' | 'version'> {
	const lines = content.split('\n');
	const owners = [...markdownTaskContexts(lines).keys()].filter(index => extractReminderId(lines[index]!) === id);
	if (!owners.length) return { state: lines.some(line => extractReminderId(line) === id) ? 'ambiguous' : 'absent' };
	if (owners.length !== 1) return { state: 'ambiguous' };
	const lineNumber = owners[0]!;
	const count = lines[lineNumber + 1]?.startsWith('<!-- crate-desc:') ? 2 : 1;
	return { state: lines.slice(lineNumber, lineNumber + count).join('\n') === side.block ? 'exact' : 'changed', lineNumber };
}

export interface ReminderMoveJournal {
	recover(): Promise<string[]>;
	hasPending(): boolean;
	isPendingFile(path: string): boolean;
	assertWritable(paths: string[]): void;
	assertActive(): void;
	execute(source: { filePath: string; rawLine: string; description?: string; id: string }, destination: { filePath: string; rawLine: string; description?: string }, mutation: () => Promise<void>): Promise<void>;
}

export function createReminderMoveJournal(app: App, directory: string, folderPath: string, signal?: AbortSignal): ReminderMoveJournal {
	const storage = createReminderMoveStorage(app.vault.adapter, directory);
	let pending: ReminderMoveRecord[] = [];
	let unknown = true;
	let queue: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const result = queue.then(work, work);
		queue = result.then(() => undefined, () => undefined);
		return result;
	};
	const assertActive = () => signal?.throwIfAborted();
	const samePath = (left: string, right: string) => portablePathKey(left) === portablePathKey(right);
	const affectsScope = (record: ReminderMoveRecord) => samePath(record.folderPath, folderPath)
		|| [record.source.filePath, record.destination.filePath].some(path => portablePathKey(path).startsWith(`${portablePathKey(folderPath)}/`));
	const issue = (record: ReminderMoveRecord) => `An interrupted reminder move needs review: ${record.source.filePath} and ${record.destination.filePath}. Keep or merge the wanted text in one note, remove the duplicate from the other, then run “Recover interrupted reminder moves”. Recovery records are kept in ${directory}.`;
	const getFile = (path: string): TFile | null => {
		const file = app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	};
	const observe = async (side: MoveSide, id: string): Promise<ObservedBlock> => {
		assertActive();
		const file = getFile(side.filePath);
		if (!file && await app.vault.adapter.exists(side.filePath)) throw new Error(`The existing note ${side.filePath} is not indexed yet. Wait for Obsidian to finish loading, then retry recovery.`);
		const version = fileVersion(file);
		const result = observeContent(file ? await readVaultMarkdown(app, file) : '', side, id);
		assertActive();
		if (fileVersion(getFile(side.filePath)) !== version) throw new Error('Reminder note changed during recovery');
		return { ...result, file, version };
	};
	const removeExact = async (side: MoveSide, id: string, otherSide: MoveSide, other: ObservedBlock) => {
		const file = getFile(side.filePath);
		if (!file) throw new Error('Reminder note disappeared during recovery');
		await processVaultMarkdown(app, file, content => {
			assertActive();
			if (fileVersion(getFile(otherSide.filePath)) !== other.version) throw new Error('Other reminder note changed during recovery');
			const observed = observeContent(content, side, id);
			if (observed.state !== 'exact' || observed.lineNumber === undefined) throw new Error('Reminder changed during recovery');
			const lines = content.split('\n');
			const length = side.block.split('\n').length;
			if (hasAttachedMarkdownContent(lines, observed.lineNumber, observed.lineNumber + length)) throw new Error('Reminder has supporting content');
			lines.splice(observed.lineNumber, length);
			return lines.join('\n');
		});
	};
	const clear = async (record: ReminderMoveRecord) => {
		assertActive();
		await storage.remove(record);
		pending = pending.filter(entry => entry.operationId !== record.operationId);
	};
	const isResolved = async (record: ReminderMoveRecord): Promise<boolean> => {
		const source = await observe(record.source, record.id);
		const destination = await observe(record.destination, record.id);
		return source.state === 'absent' && ['exact', 'changed'].includes(destination.state)
			|| destination.state === 'absent' && ['exact', 'changed'].includes(source.state);
	};
	const journal: ReminderMoveJournal = {
		hasPending: () => unknown || pending.length > 0,
		isPendingFile: path => unknown || pending.some(record => samePath(record.source.filePath, path) || samePath(record.destination.filePath, path)),
		assertActive,
		assertWritable(paths) {
			assertActive();
			if (unknown) throw new Error(`Reminder recovery records could not be read. Check ${directory}, then run “Recover interrupted reminder moves”.`);
			const blocked = pending.find(record => paths.some(path => samePath(record.source.filePath, path) || samePath(record.destination.filePath, path)));
			if (blocked) throw new Error(issue(blocked));
		},
		recover: () => enqueue(async () => {
			assertActive();
			const issues: string[] = [];
			try { pending = (await storage.read()).filter(affectsScope); unknown = false; }
			catch (error) { unknown = true; return [`Reminder recovery records could not be read in ${directory}: ${error instanceof Error ? error.message : 'Read failed'}. No ambiguous identities were repaired.`]; }
			for (const record of [...pending]) {
				if (!samePath(record.folderPath, folderPath)) {
					issues.push(`${issue(record)} Switch the reminder folder back to ${record.folderPath} before retrying recovery.`);
					continue;
				}
				try {
					const source = await observe(record.source, record.id);
					const destination = await observe(record.destination, record.id);
					if (source.state === 'exact' && destination.state === 'exact') {
						await removeExact(record.source, record.id, record.destination, destination);
					} else if (source.state === 'changed' && destination.state === 'exact') {
						await removeExact(record.destination, record.id, record.source, source);
					} else if (!(source.state === 'absent' && ['exact', 'changed'].includes(destination.state)
						|| destination.state === 'absent' && ['exact', 'changed'].includes(source.state))) {
						issues.push(issue(record)); continue;
					}
					if (await isResolved(record)) await clear(record);
					else issues.push(issue(record));
				} catch (error) { assertActive(); issues.push(`${issue(record)} ${error instanceof Error ? error.message : 'Recovery failed'}`); }
			}
			return issues;
		}),
		execute: (source, destination, mutation) => enqueue(async () => {
			journal.assertWritable([source.filePath, destination.filePath]);
			const record: ReminderMoveRecord = {
				version: 1, operationId: crypto.randomUUID(), folderPath, id: source.id,
				source: { filePath: source.filePath, block: [source.rawLine, ...buildDescriptionBlock(source.description)].join('\n') },
				destination: { filePath: destination.filePath, block: [destination.rawLine, ...buildDescriptionBlock(destination.description)].join('\n') },
			};
			if ((await observe(record.source, record.id)).state !== 'exact' || (await observe(record.destination, record.id)).state !== 'absent') {
				throw new Error('The reminder source or destination changed. Refresh before moving; nothing was changed.');
			}
			// Track before awaiting publication: an uncertain storage response must
			// block subsequent edits until the durable journal can be reconciled.
			pending.push(record);
			await storage.write(record);
			assertActive();
			try { await mutation(); }
			catch (error) {
				if (!signal?.aborted) {
					try { if (await isResolved(record)) await clear(record); }
					catch { /* Retain the record whenever rollback acknowledgement is uncertain. */ }
				}
				throw error;
			}
			const remainingSource = await observe(record.source, record.id);
			const savedDestination = await observe(record.destination, record.id);
			if (remainingSource.state !== 'absent' || savedDestination.state !== 'exact') throw new Error(issue(record));
			await clear(record);
		}),
	};
	return journal;
}
