import type { DataAdapter, Plugin } from 'obsidian';
import { createLogger } from '../plugin/logger';
import { isRecord } from '../plugin/settings';
import { validateUploadIntent, type JournalUpload } from './upload-intent';
import { computeHash } from './hasher';
import type { SyncState } from './types';

const DAY = 24 * 60 * 60 * 1000;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const backupName = new RegExp(`^upload-(e1_[0-9]{8}_${uuid})\\.json\\.previous-${uuid}$`);
const logger = createLogger('Checkpoint cleanup');

/** Retired upload copies are redundant only when ALL saved bytes still exist locally.
 * Age, a successful sync, and an upload receipt alone are not preservation evidence.
 * Unknown records, manifests, and merge preimages that differ are retained.
 */
export async function pruneCheckpointBackups(adapter: DataAdapter, directory: string, signal: AbortSignal): Promise<number> {
	let removed = 0;
	if (signal.aborted) return removed;
	const listing = await adapter.list(directory);
	for (const path of listing.files) {
		if (signal.aborted) break;
		if (!path.startsWith(`${directory}/`)) continue;
		const match = backupName.exec(path.slice(directory.length + 1));
		if (!match) continue;
		try {
			const original = await adapter.read(path);
			const record: unknown = JSON.parse(original);
			if (!isRecord(record) || record.version !== 2 || typeof record.authority !== 'string'
				|| !record.authority || !Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1
				|| !isRecord(record.file) || record.file.operationId !== match[1]) continue;
			await validateUploadIntent(record.file);
			const file = record.file as unknown as JournalUpload;
			// Never accept another private plugin file as proof of a preserved note.
			if (file.path === directory || file.path.startsWith(`${directory}/`)) continue;
			if (file.intent.kind === 'merge' && file.intent.preimage.hash !== file.hash) continue;
			if (signal.aborted) break;
			const bytes = await adapter.readBinary(file.path);
			if (bytes.byteLength !== file.size || await computeHash(bytes) !== file.hash) continue;
			// Do not remove a backup replaced while its contents were being checked.
			if (await adapter.read(path) !== original || signal.aborted) continue;
			await adapter.remove(path);
			removed++;
		} catch (error) {
			if (!signal.aborted) logger.debug('Kept a sync backup that could not be verified:', error);
		}
	}
	return removed;
}

type CleanupPlugin = Plugin & { syncRuntime: {
	getState(): SyncState;
	addStateChangeListener(listener: (state: SyncState) => void): void;
	removeStateChangeListener(listener: (state: SyncState) => void): void;
} };

export function registerCheckpointBackupCleanup(plugin: CleanupPlugin, signal: AbortSignal): void {
	let running = false;
	const run = async () => {
		if (running || signal.aborted || !plugin.manifest.dir || plugin.syncRuntime.getState().status === 'syncing') return;
		running = true;
		try {
			await pruneCheckpointBackups(plugin.app.vault.adapter, plugin.manifest.dir, signal);
		} catch (error) {
			if (!signal.aborted) logger.warn('Could not check redundant sync backups:', error);
		} finally {
			running = false;
		}
	};
	let timer = window.setTimeout(() => { void run(); }, 60_000);
	let wasSyncing = false;
	const listener = (state: SyncState) => {
		if (wasSyncing && state.status === 'idle') {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => { void run(); }, 5_000);
		}
		wasSyncing = state.status === 'syncing';
	};
	plugin.syncRuntime.addStateChangeListener(listener);
	plugin.register(() => {
		window.clearTimeout(timer);
		plugin.syncRuntime.removeStateChangeListener(listener);
	});
	plugin.registerInterval(window.setInterval(() => { void run(); }, DAY));
}
