import type { RemoteReminderRecord } from '../types';
import { changedRows } from '../../db';
import {
	REMINDER_CACHE_MAX_VALUE_BYTES,
	REMINDER_CACHE_PARSER_VERSION,
	type ReminderFileCacheEntry,
} from './types';

interface SerializedReminderFileCacheEntry {
	entry: ReminderFileCacheEntry;
	remindersJson: string;
}

export interface ReminderFileCacheWriteResult {
	persistedPaths: string[];
	oversizedPaths: string[];
}

function serializeCacheEntry(entry: ReminderFileCacheEntry): SerializedReminderFileCacheEntry | null {
	const remindersJson = JSON.stringify(entry.issue ? { issue: entry.issue } : entry.reminders);
	if (new TextEncoder().encode(remindersJson).byteLength > REMINDER_CACHE_MAX_VALUE_BYTES) {
		return null;
	}
	return { entry, remindersJson };
}

function createCacheUpsertStatement(
	db: D1Database,
	folderPath: string,
	serialized: SerializedReminderFileCacheEntry,
): D1PreparedStatement {
	const { entry, remindersJson } = serialized;
	return db.prepare(`INSERT INTO reminder_file_cache (
			folder_path, file_path, file_hash, parser_version, reminders_json, updated_at
		)
		SELECT ?, ?, ?, ?, ?, datetime('now')
		WHERE EXISTS (
			SELECT 1 FROM files WHERE path = ? AND hash = ?
		)
		ON CONFLICT(folder_path, file_path) DO UPDATE SET
			file_hash = excluded.file_hash,
			parser_version = excluded.parser_version,
			reminders_json = excluded.reminders_json,
			updated_at = datetime('now')`)
		.bind(
			folderPath,
			entry.filePath,
			entry.fileHash,
			REMINDER_CACHE_PARSER_VERSION,
			remindersJson,
			entry.filePath,
			entry.fileHash,
		);
}

export async function writeReminderFileCacheEntries(
	db: D1Database,
	folderPath: string,
	entries: ReminderFileCacheEntry[],
): Promise<ReminderFileCacheWriteResult> {
	const oversizedPaths: string[] = [];
	const serializedEntries: SerializedReminderFileCacheEntry[] = [];
	for (const entry of entries) {
		const serialized = serializeCacheEntry(entry);
		if (serialized) {
			serializedEntries.push(serialized);
		} else {
			oversizedPaths.push(entry.filePath);
			entry.reminders = [];
			entry.issue = 'Split this note into smaller files to index its reminders. The vault file remains synced.';
			serializedEntries.push({ entry, remindersJson: JSON.stringify({ issue: entry.issue }) });
		}
	}

	const persistedPaths: string[] = [];
	for (let index = 0; index < serializedEntries.length; index += 50) {
		const entryBatch = serializedEntries.slice(index, index + 50);
		const results = await db.batch(
			entryBatch.map((entry) => createCacheUpsertStatement(db, folderPath, entry)),
		);
		for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
			const entry = entryBatch[resultIndex];
			if (entry && changedRows(results[resultIndex]) > 0) {
				persistedPaths.push(entry.entry.filePath);
			}
		}
	}

	return {
		persistedPaths,
		oversizedPaths,
	};
}

export async function pruneReminderFileCache(db: D1Database, folderPath: string): Promise<void> {
	await db.prepare(`DELETE FROM reminder_file_cache
		WHERE folder_path = ?
		AND NOT EXISTS (
			SELECT 1 FROM files WHERE path = reminder_file_cache.file_path
		)`).bind(folderPath).run();
}

export async function saveReminderFileCache(
	db: D1Database,
	folderPath: string,
	filePath: string,
	fileHash: string,
	reminders: RemoteReminderRecord[],
): Promise<void> {
	try {
		await writeReminderFileCacheEntries(db, folderPath, [{ filePath, fileHash, reminders }]);
	} catch {
		// Parsed reminder caching is an optimization and must not fail mutations.
	}
}
