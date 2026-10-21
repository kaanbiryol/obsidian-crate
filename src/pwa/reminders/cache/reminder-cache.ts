import { capturePwaSession } from '../../session-generation';
import type { CachedReminderSnapshot, ReminderRecord, ReminderSourceIssue } from '../types';
import { AUTH_TOKEN_KEY } from '../../config';
import { CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME, deleteCacheDatabase, openCacheDatabase, reminderCacheHealth, reportCacheProblem } from './reminder-cache-database';
import { normalizeSnapshot } from './reminder-cache-validation';
import { sealPrivateValue, openPrivateValue, privateStorageEnabled } from '../private-storage';
import { sha256Hex } from '../../../platform/sha256';

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
	return sha256Hex(token);
}

/** Metadata for one folder's snapshot. It lists each note's random write
 * version and commits with the notes, so a missing, extra or replaced note
 * rejects the whole snapshot, and a save learns what is stored without reading
 * the notes. Versions carry no content. */
interface SnapshotMetadata {
	layout: 'notes';
	projects: string[];
	savedAt: number;
	etag?: string;
	deltaBase?: string;
	issues: ReminderSourceIssue[];
	noteVersions: [path: string, version: string][];
}

type StoredMetadata = Partial<SnapshotMetadata> & { sessionScope?: string; encrypted?: string };

interface StoredNote { folderPath: string; path: string; sessionScope: string; version: string; encrypted?: string; reminders?: ReminderRecord[] }

/** What this tab last read or wrote for a folder: note versions, their JSON and
 * the record objects it was serialized from. */
interface PersistedNote { version: string; json: string; reminders: ReminderRecord[] }
const persisted = new Map<string, { scope: string; generation: number; notes: Map<string, PersistedNote> }>();

const noteRange = (folderPath: string) => IDBKeyRange.bound([folderPath], [folderPath, []]);
const noteKey = (sessionScope: string, folderPath: string, path: string) => `cache-note:${sessionScope}:${folderPath}:${path}`;
/** Synchronous, so a write transaction never waits on non-IndexedDB work and
 * auto-commits early. Null when the record belongs to another session, does not
 * match the private storage setting or is damaged. */
function openMetadata(raw: StoredMetadata, sessionScope: string, folderPath: string): { metadata: Partial<SnapshotMetadata>; versions: Map<string, string> } | null {
	try {
		if (raw.sessionScope !== sessionScope || Boolean(raw.encrypted) !== privateStorageEnabled()) return null;
		const metadata = (raw.encrypted ? JSON.parse(openPrivateValue(raw.encrypted, `cache:${sessionScope}:${folderPath}`)) : raw) as Partial<SnapshotMetadata>;
		if (metadata.layout !== 'notes' || !Array.isArray(metadata.noteVersions)) return null;
		const versions = new Map<string, string>();
		for (const entry of metadata.noteVersions as unknown[]) {
			if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || versions.has(entry[0])) return null;
			versions.set(entry[0], entry[1]);
		}
		return { metadata, versions };
	} catch {
		return null;
	}
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
				transaction.objectStore(CACHE_STORE_NAME).get(folderPath) as Promise<StoredMetadata | undefined>,
				transaction.objectStore(FRESHNESS_STORE_NAME).get(folderPath) as Promise<CacheFreshness | undefined>,
				transaction.objectStore(NOTES_STORE_NAME).getAll(noteRange(folderPath)) as Promise<StoredNote[]>,
			]))(),
		]);
		if (raw && !raw.encrypted && privateStorageEnabled()) {
			// Plaintext reminders must not outlive the switch to private storage.
			const cleanup = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME], 'readwrite');
			await Promise.all([
				cleanup.objectStore(CACHE_STORE_NAME).delete(folderPath),
				cleanup.objectStore(FRESHNESS_STORE_NAME).delete(folderPath),
				cleanup.objectStore(NOTES_STORE_NAME).delete(noteRange(folderPath)),
				cleanup.done,
			]);
			return null;
		}
		if (!raw || raw.sessionScope !== sessionScope) return null;
		const snapshot = await assembleSnapshot(folderPath, sessionScope, raw, notes);
		reportCacheProblem(snapshot ? null : 'damaged');
		// The next save then rewrites every note instead of trusting this tab's record.
		if (!snapshot) { persisted.delete(folderPath); return null; }
		// A late revalidation must never update the timestamp of a different revision.
		if (snapshot.etag && freshness?.etag === snapshot.etag && Number.isFinite(freshness.savedAt)) {
			snapshot.savedAt = Math.max(snapshot.savedAt, freshness.savedAt);
		}
		return snapshot;
	} finally {
		database.close();
	}

	async function assembleSnapshot(folderPath: string, sessionScope: string, raw: StoredMetadata, notes: StoredNote[]): Promise<CachedReminderSnapshot | null> {
		try {
			const opened = openMetadata(raw, sessionScope, folderPath);
			if (!opened || notes.length !== opened.versions.size || notes.some(note => opened.versions.get(note.path) !== note.version)) return null;
			const { metadata } = opened;
			const reminders: ReminderRecord[] = [];
			const read = new Map<string, PersistedNote>();
			for (const note of notes) {
				if (note.sessionScope !== sessionScope || typeof note.version !== 'string' || typeof note.path !== 'string') return null;
				if (privateStorageEnabled() !== Boolean(note.encrypted)) return null;
				// The decrypted text is the JSON the write path compares, so reuse it.
				const openedJson = note.encrypted ? openPrivateValue(note.encrypted, noteKey(sessionScope, folderPath, note.path)) : undefined;
				const value: unknown = openedJson !== undefined ? JSON.parse(openedJson) : note.reminders;
				if (!Array.isArray(value) || !value.length || value.some(reminder => !reminder || typeof reminder !== 'object' || (reminder as ReminderRecord).filePath !== note.path)) return null;
				reminders.push(...value as ReminderRecord[]);
				read.set(note.path, { version: note.version, json: openedJson ?? JSON.stringify(value), reminders: value as ReminderRecord[] });
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
 * metadata and every note change commit in one transaction, so the stored note
 * versions come from the metadata alone; unreadable metadata replaces every note. */
async function writeIndexedDbSnapshot(snapshot: CachedReminderSnapshot): Promise<void> {
	const sessionCurrent = capturePwaSession();
	const generation = cacheGeneration;
	const sessionScope = await cacheSessionScope();
	const { folderPath } = snapshot;
	const known = persisted.get(folderPath);
	const previous = known?.scope === sessionScope && known.generation === generation ? known.notes : new Map<string, PersistedNote>();
	// Confirmed records are immutable: a note holding the same record objects reuses its JSON.
	const next = new Map([...groupByNote(snapshot.reminders)].map(([path, reminders]) => {
		const prior = previous.get(path);
		const same = prior?.reminders.length === reminders.length && reminders.every((reminder, index) => reminder === prior.reminders[index]);
		return [path, { reminders, json: same ? prior.json : JSON.stringify(reminders) }];
	}));
	const database = await openCacheDatabase();
	try {
		if (!sessionCurrent() || generation !== cacheGeneration) return;
		const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME], 'readwrite');
		const written = new Map<string, PersistedNote>();
		async function writeNotes(): Promise<void> {
			const notesStore = transaction.objectStore(NOTES_STORE_NAME);
			const stored = await transaction.objectStore(CACHE_STORE_NAME).get(folderPath) as StoredMetadata | undefined;
			const storedVersions = stored ? openMetadata(stored, sessionScope, folderPath)?.versions : undefined;
			if (!storedVersions) await notesStore.delete(noteRange(folderPath));
			const onDisk = storedVersions ?? new Map<string, string>();
			for (const path of onDisk.keys()) if (!next.has(path)) await notesStore.delete([folderPath, path]);
			for (const [path, note] of next) {
				const prior = previous.get(path);
				if (prior && prior.json === note.json && onDisk.get(path) === prior.version) { written.set(path, { ...prior, reminders: note.reminders }); continue; }
				const version = crypto.randomUUID();
				const sealed = sealPrivateValue(note.json, noteKey(sessionScope, folderPath, path));
				await notesStore.put(sealed === note.json ? { folderPath, path, sessionScope, version, reminders: note.reminders }
					: { folderPath, path, sessionScope, version, encrypted: sealed } satisfies StoredNote);
				written.set(path, { version, json: note.json, reminders: note.reminders });
			}
			const metadata: SnapshotMetadata = { layout: 'notes', projects: snapshot.projects, savedAt: snapshot.savedAt, etag: snapshot.etag,
				...(snapshot.deltaBase ? { deltaBase: snapshot.deltaBase } : {}), issues: snapshot.issues ?? [],
				noteVersions: [...written].map(([path, note]) => [path, note.version]) };
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

export async function saveCachedReminderSnapshot(input: Omit<CachedReminderSnapshot, 'savedAt' | 'issues'> & Partial<Pick<CachedReminderSnapshot, 'savedAt' | 'issues'>>): Promise<void> {
	const { folderPath, deltaBase, ...rest } = input;
	const snapshot: CachedReminderSnapshot = { ...rest, folderPath, savedAt: input.savedAt ?? Date.now(), issues: input.issues ?? [], ...(deltaBase ? { deltaBase } : {}) };
	try {
		// Callers pass confirmed in-memory records, each validated when it entered the app.
		if (!normalizeSnapshot(snapshot, folderPath, true)) { reportCacheProblem('damaged'); return; }
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
