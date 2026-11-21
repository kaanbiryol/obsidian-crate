import { TFile, type App } from 'obsidian';
import { extractReminderId } from '../core/reminderIdentity';
import { buildDescriptionBlock, readDescriptionBlock } from '../core/reminderDescription';
import { hasAttachedMarkdownContent, markdownTaskContexts } from '../core/markdownTaskContext';
import { createReminderMoveStorage, type ReminderArchiveRecord, type ReminderJournalRecord, type ReminderMoveRecord } from './reminder-move-storage';
import { appendArchivedBlocks, hasArchivedBlock, planReminderArchive, removeArchivedBlocks, type ArchivedReminderBlock } from '../core/reminder-archive';
import { portablePathKey } from '@/protocol/portable-path';
import { readVaultMarkdown, processVaultMarkdown } from '@/reminders/data/vault-markdown';

type MoveSide = ReminderMoveRecord['source'];
type ObservedBlock = { state: 'absent' | 'changed' | 'exact' | 'ambiguous'; lineNumber?: number; block?: string; file: TFile | null; version: string | null };
const fileVersion = (file: TFile | null) => file ? `${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}` : null;

function observeContent(content: string, side: MoveSide, id: string): Omit<ObservedBlock, 'file' | 'version'> {
	const lines = content.split('\n');
	const owners = [...markdownTaskContexts(lines).keys()].filter(index => extractReminderId(lines[index]!) === id);
	if (!owners.length) return { state: lines.some(line => extractReminderId(line) === id) ? 'ambiguous' : 'absent' };
	if (owners.length !== 1) return { state: 'ambiguous' };
	const lineNumber = owners[0]!;
	const count = 1 + readDescriptionBlock(lines, lineNumber).lineCount;
	const block = lines.slice(lineNumber, lineNumber + count).join('\n');
	return { state: block === side.block ? 'exact' : 'changed', lineNumber, block };
}

interface ReminderArchiveResult {
	archived: number;
	skipped: number;
}

export interface ReminderMoveJournal {
	recover(): Promise<string[]>;
	hasPending(): boolean;
	isPendingFile(path: string): boolean;
	assertWritable(paths: string[]): void;
	assertActive(): void;
	execute(source: { filePath: string; rawLine: string; description?: string; id: string }, destination: { filePath: string; rawLine: string; description?: string }, mutation: () => Promise<void>): Promise<void>;
	/** Moves the note's completed reminders to the end of its archive note, created on demand. */
	archive(sourcePath: string, destinationPath: string, createDestination: () => Promise<TFile>): Promise<ReminderArchiveResult>;
}

export function createReminderMoveJournal(app: App, directory: string, folderPath: string, signal?: AbortSignal): ReminderMoveJournal {
	const storage = createReminderMoveStorage(app.vault.adapter, directory);
	let pending: ReminderJournalRecord[] = [];
	let unknown = true;
	let queue: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const result = queue.then(work, work);
		queue = result.then(() => undefined, () => undefined);
		return result;
	};
	const assertActive = () => signal?.throwIfAborted();
	const samePath = (left: string, right: string) => portablePathKey(left) === portablePathKey(right);
	const affectsScope = (record: ReminderJournalRecord) => samePath(record.folderPath, folderPath)
		|| [record.source.filePath, record.destination.filePath].some(path => portablePathKey(path).startsWith(`${portablePathKey(folderPath)}/`));
	const issue = (record: ReminderJournalRecord) => record.kind === 'archive'
		? `An interrupted reminder archive needs review: ${record.source.filePath} and ${record.destination.filePath}. Crate retries recovery after the next sync or reload. Recovery records are kept in ${directory}.`
		: `An interrupted reminder move needs review: ${record.source.filePath} and ${record.destination.filePath}. Keep or merge the wanted text in one note and remove the duplicate from the other. Crate retries recovery after the next sync or reload. Recovery records are kept in ${directory}.`;
	const getFile = (path: string): TFile | null => {
		const file = app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	};
	const observe = async (side: MoveSide, id: string): Promise<ObservedBlock> => {
		assertActive();
		const file = getFile(side.filePath);
		if (!file && await app.vault.adapter.exists(side.filePath)) throw new Error(`The existing note ${side.filePath} is not indexed yet. Wait for Obsidian to finish loading, then retry recovery.`);
		const version = fileVersion(file);
		const result = observeContent(file ? await readVaultMarkdown(app.vault, file) : '', side, id);
		assertActive();
		if (fileVersion(getFile(side.filePath)) !== version) throw new Error('Reminder note changed during recovery');
		return { ...result, file, version };
	};
	const removeExact = async (side: MoveSide, id: string, otherSide: MoveSide, other: ObservedBlock) => {
		const file = getFile(side.filePath);
		if (!file) throw new Error('Reminder note disappeared during recovery');
		await processVaultMarkdown(app.vault, file, content => {
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
	const clear = async (record: ReminderJournalRecord) => {
		assertActive();
		await storage.remove(record);
		pending = pending.filter(entry => entry.operationId !== record.operationId);
	};
	const requireIndexed = async (path: string) => {
		if (!getFile(path) && await app.vault.adapter.exists(path)) throw new Error(`The existing note ${path} is not indexed yet. Wait for Obsidian to finish loading, then retry recovery.`);
	};
	/** Finishes removal for every reminder the archive holds. One it never received stays in
	 * its project, so recovery leaves at worst an extra archived copy, never a lost reminder. */
	const recoverArchive = async (record: ReminderArchiveRecord) => {
		assertActive();
		await requireIndexed(record.source.filePath);
		await requireIndexed(record.destination.filePath);
		const destination = getFile(record.destination.filePath);
		const version = fileVersion(destination);
		const archived = destination ? await readVaultMarkdown(app.vault, destination) : '';
		const moved = record.blocks.filter(block => hasArchivedBlock(archived, block));
		const source = getFile(record.source.filePath);
		if (source && moved.length) {
			await processVaultMarkdown(app.vault, source, content => {
				assertActive();
				if (fileVersion(getFile(record.destination.filePath)) !== version) throw new Error('Archive note changed during recovery');
				return removeArchivedBlocks(content, moved).content;
			});
		}
		await clear(record);
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
			if (unknown) throw new Error(`Reminder recovery records could not be read. Check ${directory}. Crate retries recovery after the next sync or reload.`);
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
				if (record.kind === 'archive') {
					try { await recoverArchive(record); }
					catch (error) { assertActive(); issues.push(`${issue(record)} ${error instanceof Error ? error.message : 'Recovery failed'}`); }
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
			const observedSource = await observe(record.source, record.id);
			const sourceLines = observedSource.block?.split('\n');
			if (!sourceLines || sourceLines[0] !== source.rawLine
				|| (readDescriptionBlock(sourceLines, 0).description ?? '') !== (source.description?.trim() ?? '')
				|| (await observe(record.destination, record.id)).state !== 'absent') {
				throw new Error('The reminder source or destination changed. Refresh before moving; nothing was changed.');
			}
			// Recovery compares exact bytes. The source may still use an older
			// description representation even though new writes use plain text.
			record.source.block = observedSource.block!;
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
		archive: (sourcePath, destinationPath, createDestination) => enqueue(async () => {
			journal.assertWritable([sourcePath, destinationPath]);
			const source = getFile(sourcePath);
			if (!source) throw new Error(`Reminder note not found: ${sourcePath}`);
			const plan = planReminderArchive(await readVaultMarkdown(app.vault, source));
			assertActive();
			if (!plan.blocks.length) return { archived: 0, skipped: plan.skipped };
			const destination = getFile(destinationPath) ?? await createDestination();
			const prepared = appendArchivedBlocks(await readVaultMarkdown(app.vault, destination), plan.blocks);
			const skipped = plan.skipped + plan.blocks.length - prepared.appended.length;
			if (!prepared.appended.length) return { archived: 0, skipped };
			const record: ReminderArchiveRecord = {
				version: 1, kind: 'archive', operationId: crypto.randomUUID(), folderPath,
				source: { filePath: sourcePath }, destination: { filePath: destinationPath }, blocks: prepared.appended,
			};
			// Track before awaiting publication, as moves do: an uncertain write must
			// hold both notes until recovery can reconcile them.
			pending.push(record);
			await storage.write(record);
			try {
				assertActive();
				// Archive first: a reminder is removed from its project only once the archive holds it.
				let replaced: ArchivedReminderBlock[] = [];
				await processVaultMarkdown(app.vault, destination, content => {
					assertActive();
					const next = appendArchivedBlocks(content, record.blocks);
					if (next.appended.length !== record.blocks.length) throw new Error('The archive note changed. Nothing was archived.');
					replaced = next.replaced;
					return next.content;
				});
				let removed = new Set<string>();
				await processVaultMarkdown(app.vault, source, content => {
					assertActive();
					const result = removeArchivedBlocks(content, record.blocks);
					removed = new Set(result.removed);
					return result.content;
				});
				// A reminder edited meanwhile stays in its project without a second, stale copy,
				// and an archived copy this run replaced comes back.
				const kept = record.blocks.filter(block => !removed.has(block.id));
				if (kept.length) {
					const restored = replaced.filter(old => !removed.has(old.id));
					await processVaultMarkdown(app.vault, destination, content =>
						appendArchivedBlocks(removeArchivedBlocks(content, kept).content, restored).content);
				}
				await clear(record);
				return { archived: removed.size, skipped: skipped + kept.length };
			} catch (error) {
				if (!signal?.aborted) {
					try { await recoverArchive(record); }
					catch { /* Retain the record whenever the notes cannot be reconciled now. */ }
				}
				throw error;
			}
		}),
	};
	return journal;
}
