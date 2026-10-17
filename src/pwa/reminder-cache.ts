import { stringDigest } from './string-digest';
import { capturePwaSession } from './session-generation';
import type { CachedReminderSnapshot, ReminderRecord, ReminderSourceIssue } from './types';
import { AUTH_TOKEN_KEY } from './config';
import { CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME, deleteCacheDatabase, openCacheDatabase, reminderCacheHealth, reportCacheProblem } from './reminder-cache-database';
import { normalizeSnapshot } from './reminder-cache-validation';
import { sealPrivateValue, openPrivateValue, privateStorageEnabled } from './private-storage';

let cacheGeneration = 0;

interface CacheFreshness {
	folderPath: string;
	savedAt: number;
	etag: string;
}

// Bind disposable content to the actual session even when an old tab blocks
// logout deletion. No credential is stored in the snapshot.
async function cacheSessionScope(): Promise<string> {
	const token = typeof localStorage === 'undefined' ? '' : localStorage.getItem(AUTH_TOKEN_KEY) ?? '';
	return stringDigest(token);
}

/** Metadata for one folder's snapshot. The note set is verified by count and a
 * digest of each note's random write version, so a missing, extra or replaced
 * note rejects the whole snapshot without storing plaintext digests. */
interface SnapshotMetadata {
	layout: 'notes';
	projects: string[];
	savedAt: number;
	etag?: string;
	deltaBase?: string;
	issues: ReminderSourceIssue[];
	noteCount: number;
	inventory: string;
}

interface StoredNote { folderPath: string; path: string; sessionScope: string; version: string; encrypted?: string; reminders?: ReminderRecord[] }

/** What this tab last read or wrote for a folder: note versions and their JSON. */
const persisted = new Map<string, { scope: string; generation: number; notes: Map<string, { version: string; json: string }> }>();

const noteRange = (folderPath: string) => IDBKeyRange.bound([folderPath], [folderPath, []]);
const noteKey = (sessionScope: string, folderPath: string, path: string) => `cache-note:${sessionScope}:${folderPath}:${path}`;
/** Synchronous, so a write transaction never waits on non-IndexedDB work and
 * auto-commits early. It detects inconsistent note sets; it is not a security
 * boundary (versions are random and carry no content). */
function inventoryDigest(notes: Iterable<[string, string]>): string {
	const text = [...notes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, version]) => `${path}\0${version}`).join('\n');
	let first = 0x811c9dc5, second = 0x9747b28c;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x5bd1e995);
	}
	return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function groupByNote(reminders: ReminderRecord[]): Map<string, ReminderRecord[]> {
	const notes = new Map<string, ReminderRecord[]>();
	for (const reminder of reminders) {
		const note = notes.get(reminder.filePath);
		if (note) note.push(reminder); else notes.set(reminder.filePath, [reminder]);
	}
	return notes;
}

async function readIndexedDbSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	const sessionScope = await cacheSessionScope();
	const generation = cacheGeneration;
	const database = await openCacheDatabase();
	try {
		const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME], 'readonly');
		const [, [raw, freshness, notes]] = await Promise.all([
			transaction.done,
			(async () => Promise.all([
				transaction.objectStore(CACHE_STORE_NAME).get(folderPath) as Promise<{ sessionScope?: string; layout?: string; encrypted?: string } | undefined>,
				transaction.objectStore(FRESHNESS_STORE_NAME).get(folderPath) as Promise<CacheFreshness | undefined>,
				transaction.objectStore(NOTES_STORE_NAME).getAll(noteRange(folderPath)) as Promise<StoredNote[]>,
			]))(),
		]);
		if (raw && !raw.encrypted && privateStorageEnabled()) {
			await database.delete(CACHE_STORE_NAME, folderPath);
			return null;
		}
		if (!raw || raw.sessionScope !== sessionScope) return null;
		const snapshot = await assembleSnapshot(folderPath, sessionScope, raw, notes);
		reportCacheProblem(snapshot ? null : 'damaged');
		if (!snapshot) return null;
		// A late revalidation must never update the timestamp of a different revision.
		if (snapshot.etag && freshness?.etag === snapshot.etag && Number.isFinite(freshness.savedAt)) {
			snapshot.savedAt = Math.max(snapshot.savedAt, freshness.savedAt);
		}
		return snapshot;
	} finally {
		database.close();
	}

	async function assembleSnapshot(folderPath: string, sessionScope: string, raw: { encrypted?: string }, notes: StoredNote[]): Promise<CachedReminderSnapshot | null> {
		try {
			const metadata = (raw.encrypted ? JSON.parse(openPrivateValue(raw.encrypted, `cache:${sessionScope}:${folderPath}`)) : raw) as Partial<SnapshotMetadata>;
			if (metadata.layout !== 'notes' || !Number.isSafeInteger(metadata.noteCount) || typeof metadata.inventory !== 'string' || notes.length !== metadata.noteCount) return null;
			if (inventoryDigest(notes.map(note => [note.path, note.version])) !== metadata.inventory) return null;
			const reminders: ReminderRecord[] = [];
			const read = new Map<string, { version: string; json: string }>();
			for (const note of notes) {
				if (note.sessionScope !== sessionScope || typeof note.version !== 'string' || typeof note.path !== 'string') return null;
				if (privateStorageEnabled() !== Boolean(note.encrypted)) return null;
				const value: unknown = note.encrypted ? JSON.parse(openPrivateValue(note.encrypted, noteKey(sessionScope, folderPath, note.path))) : note.reminders;
				if (!Array.isArray(value) || !value.length || value.some(reminder => !reminder || typeof reminder !== 'object' || (reminder as ReminderRecord).filePath !== note.path)) return null;
				reminders.push(...value as ReminderRecord[]);
				read.set(note.path, { version: note.version, json: JSON.stringify(value) });
			}
			const snapshot = normalizeSnapshot({ folderPath, reminders, projects: metadata.projects, savedAt: metadata.savedAt, etag: metadata.etag,
				deltaBase: metadata.deltaBase, issues: metadata.issues }, folderPath);
			if (snapshot && generation === cacheGeneration) persisted.set(folderPath, { scope: sessionScope, generation, notes: read });
			return snapshot;
		} catch {
			return null;
		}
	}
}

/** Writes only notes whose contents changed, plus notes another tab rewrote. The
 * metadata and every note change commit in one transaction. */
async function writeIndexedDbSnapshot(snapshot: CachedReminderSnapshot): Promise<void> {
	const sessionCurrent = capturePwaSession();
	const generation = cacheGeneration;
	const sessionScope = await cacheSessionScope();
	const { folderPath } = snapshot;
	const next = new Map([...groupByNote(snapshot.reminders)].map(([path, reminders]) => [path, { reminders, json: JSON.stringify(reminders) }]));
	const known = persisted.get(folderPath);
	const previous = known?.scope === sessionScope && known.generation === generation ? known.notes : new Map<string, { version: string; json: string }>();
	const database = await openCacheDatabase();
	try {
		if (!sessionCurrent() || generation !== cacheGeneration) return;
		const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME], 'readwrite');
		const written = new Map<string, { version: string; json: string }>();
		async function writeNotes(): Promise<void> {
			const notesStore = transaction.objectStore(NOTES_STORE_NAME);
			const onDisk = new Map((await notesStore.getAll(noteRange(folderPath)) as StoredNote[])
				.map(note => [note.path, note.sessionScope === sessionScope ? note.version : '']));
			for (const path of onDisk.keys()) if (!next.has(path)) await notesStore.delete([folderPath, path]);
			for (const [path, note] of next) {
				const prior = previous.get(path);
				if (prior && prior.json === note.json && onDisk.get(path) === prior.version) { written.set(path, prior); continue; }
				const version = crypto.randomUUID();
				const sealed = sealPrivateValue(note.json, noteKey(sessionScope, folderPath, path));
				await notesStore.put(sealed === note.json ? { folderPath, path, sessionScope, version, reminders: note.reminders }
					: { folderPath, path, sessionScope, version, encrypted: sealed } satisfies StoredNote);
				written.set(path, { version, json: note.json });
			}
			const metadata: SnapshotMetadata = { layout: 'notes', projects: snapshot.projects, savedAt: snapshot.savedAt, etag: snapshot.etag,
				...(snapshot.deltaBase ? { deltaBase: snapshot.deltaBase } : {}), issues: snapshot.issues ?? [],
				noteCount: written.size, inventory: inventoryDigest([...written].map(([path, note]) => [path, note.version])) };
			const plain = JSON.stringify({ ...metadata, sessionScope });
			const protectedValue = sealPrivateValue(plain, `cache:${sessionScope}:${folderPath}`);
			await transaction.objectStore(CACHE_STORE_NAME).put(protectedValue === plain ? { folderPath, ...metadata, sessionScope }
				: { folderPath, sessionScope, layout: 'notes', encrypted: protectedValue });
			await transaction.objectStore(FRESHNESS_STORE_NAME).delete(folderPath);
		}
		await Promise.all([
			transaction.done,
			(async () => {
				try { await writeNotes(); }
				catch (error) {
					// A throwing request does not abort its transaction; earlier note
					// writes must not commit without their metadata.
					try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
					throw error;
				}
			})(),
		]);
		if (generation === cacheGeneration) persisted.set(folderPath, { scope: sessionScope, generation, notes: written });
		reportCacheProblem(null);
	} catch (error) {
		persisted.delete(folderPath);
		throw error;
	} finally {
		database.close();
	}
}

export async function loadCachedReminderSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	try {
		const sessionCurrent = capturePwaSession();
		const generation = cacheGeneration;
		const snapshot = await readIndexedDbSnapshot(folderPath);
		return sessionCurrent() && generation === cacheGeneration ? snapshot : null;
	} catch {
		if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable');
		return null;
	}
}

export async function saveCachedReminderSnapshot(
	folderPath: string,
	reminders: ReminderRecord[],
	projects: string[],
	savedAt = Date.now(),
	etag?: string,
	issues: ReminderSourceIssue[] = [],
	deltaBase?: string,
): Promise<void> {
	const snapshot: CachedReminderSnapshot = { folderPath, reminders, projects, savedAt, etag, issues, ...(deltaBase ? { deltaBase } : {}) };
	try {
		if (!normalizeSnapshot(snapshot, folderPath)) { reportCacheProblem('damaged'); return; }
		await writeIndexedDbSnapshot(snapshot);
	} catch {
		if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable');
	}
}

export async function clearCachedReminderSnapshots(isCurrent: () => boolean = () => true): Promise<boolean> {
	if (!isCurrent()) return true;
	cacheGeneration += 1;
	return deleteCacheDatabase();
}

/** Rebuild only the current known read-cache stores. Never erase an unknown format. */
export async function rebuildCachedReminderSnapshot(folderPath: string): Promise<boolean> {
	cacheGeneration += 1;
	try {
		const sessionCurrent = capturePwaSession();
		const generation = cacheGeneration;
		const database = await openCacheDatabase();
		try {
			if (!sessionCurrent() || generation !== cacheGeneration) return false;
			const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME], 'readwrite');
			await Promise.all([
				transaction.done,
				(async () => {
					await transaction.objectStore(CACHE_STORE_NAME).delete(folderPath);
					await transaction.objectStore(FRESHNESS_STORE_NAME).delete(folderPath);
					await transaction.objectStore(NOTES_STORE_NAME).delete(noteRange(folderPath));
				})(),
			]);
			persisted.delete(folderPath);
		} finally { database.close(); }
		reportCacheProblem(null);
		return true;
	} catch { if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable'); return false; }
}

/** Persist a successful revalidation without cloning or rewriting reminder contents. */
export async function refreshCachedReminderSnapshot(folderPath: string, savedAt: number, etag?: string): Promise<void> {
	if (!etag) return;
	const sessionCurrent = capturePwaSession();
	const generation = cacheGeneration;
	try {
		const database = await openCacheDatabase();
		try {
			if (!sessionCurrent() || generation !== cacheGeneration) return;
			await database.put(FRESHNESS_STORE_NAME, { folderPath, savedAt, etag } satisfies CacheFreshness);
		} finally {
			database.close();
		}
	} catch {
		if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable');
	}
}
