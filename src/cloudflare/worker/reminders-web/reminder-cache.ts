import { queryRows } from '../db';
import {
	readStoredMarkdownFiles,
	type StoredMarkdownFileMetadata,
} from '../storage';
import type { Env } from '../types';
import { getProjectFromPath, scanReminderMarkdownFile } from './scan';
import type { RemoteReminderRecord } from './types';

// Bump when parsing behavior or the cached reminder shape changes. The list
// ETag includes this value so clients revalidate even when file hashes do not.
export const REMINDER_CACHE_PARSER_VERSION = 1;

interface ReminderFileCacheRow {
	file_path: string;
	file_hash: string;
	parser_version: number;
	reminders_json: string;
}

export interface ReminderFileCacheEntry {
	filePath: string;
	fileHash: string;
	reminders: RemoteReminderRecord[];
}

function parseCachedReminders(value: string): RemoteReminderRecord[] | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return null;
		if (!parsed.every((reminder) => (
			reminder !== null
			&& typeof reminder === 'object'
			&& typeof (reminder as Partial<RemoteReminderRecord>).id === 'string'
			&& typeof (reminder as Partial<RemoteReminderRecord>).content === 'string'
			&& typeof (reminder as Partial<RemoteReminderRecord>).filePath === 'string'
			&& typeof (reminder as Partial<RemoteReminderRecord>).lineNumber === 'number'
		))) {
			return null;
		}
		return parsed as RemoteReminderRecord[];
	} catch {
		return null;
	}
}

async function loadReminderFileCache(
	db: D1Database,
	folderPath: string,
): Promise<Map<string, ReminderFileCacheEntry>> {
	const rows = await queryRows<ReminderFileCacheRow>(db.prepare(`SELECT file_path, file_hash, parser_version, reminders_json
		FROM reminder_file_cache
		WHERE folder_path = ?`).bind(folderPath));
	const entries = new Map<string, ReminderFileCacheEntry>();
	for (const row of rows) {
		if (row.parser_version !== REMINDER_CACHE_PARSER_VERSION) continue;
		const reminders = parseCachedReminders(row.reminders_json);
		if (!reminders) continue;
		entries.set(row.file_path, {
			filePath: row.file_path,
			fileHash: row.file_hash,
			reminders,
		});
	}
	return entries;
}

function createCacheUpsertStatement(
	db: D1Database,
	folderPath: string,
	entry: ReminderFileCacheEntry,
): D1PreparedStatement {
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
			JSON.stringify(entry.reminders),
			entry.filePath,
			entry.fileHash,
		);
}

async function writeReminderFileCacheEntries(
	db: D1Database,
	folderPath: string,
	entries: ReminderFileCacheEntry[],
): Promise<void> {
	const statements = entries.map((entry) => createCacheUpsertStatement(db, folderPath, entry));
	for (let index = 0; index < statements.length; index += 50) {
		await db.batch(statements.slice(index, index + 50));
	}
}

async function pruneReminderFileCache(db: D1Database, folderPath: string): Promise<void> {
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

export async function loadIncrementalReminderIndex(
	env: Env,
	folderPath: string,
	metadata: StoredMarkdownFileMetadata[],
): Promise<{ reminders: RemoteReminderRecord[]; projects: string[] }> {
	let cachedFiles = new Map<string, ReminderFileCacheEntry>();
	try {
		cachedFiles = await loadReminderFileCache(env.DB, folderPath);
	} catch {
		// Missing migrations or a transient D1 error fall back to reading R2.
	}

	const resolvedFiles = new Map<string, ReminderFileCacheEntry>();
	const staleMetadata: StoredMarkdownFileMetadata[] = [];
	for (const file of metadata) {
		const cached = cachedFiles.get(file.path);
		if (cached?.fileHash === file.hash) {
			resolvedFiles.set(file.path, cached);
		} else {
			staleMetadata.push(file);
		}
	}

	const freshFiles = await readStoredMarkdownFiles(env.BUCKET, staleMetadata);
	const freshEntries = freshFiles.map((file): ReminderFileCacheEntry => ({
		filePath: file.path,
		fileHash: file.hash,
		reminders: scanReminderMarkdownFile(file.path, file.content, folderPath),
	}));
	for (const entry of freshEntries) {
		resolvedFiles.set(entry.filePath, entry);
	}

	try {
		await writeReminderFileCacheEntries(env.DB, folderPath, freshEntries);
		await pruneReminderFileCache(env.DB, folderPath);
	} catch {
		// Serve the freshly parsed response even when cache maintenance fails.
	}

	const reminders: RemoteReminderRecord[] = [];
	const projects = new Set<string>();
	for (const file of metadata) {
		const resolved = resolvedFiles.get(file.path);
		if (!resolved) continue;
		projects.add(getProjectFromPath(file.path, folderPath));
		reminders.push(...resolved.reminders);
	}

	return {
		reminders,
		projects: Array.from(projects).sort((left, right) => left.localeCompare(right)),
	};
}
