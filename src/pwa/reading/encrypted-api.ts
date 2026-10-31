import { applyLocalArticle } from '../../reading/core/article';
import { isEmptyReadingCapture, readingUpdateIssue } from '../../reading/core/mutation-policy';
import type { CapturedArticle } from '../../reading/extraction/types';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { decryptJson, encryptJson } from '@/encryption/envelope';
import { createReadingNote, parseReadingNote, updateReadingNote, readingImportId } from '../../reading/core/notes';
import { readReadingFrontmatter, patchReadingFrontmatter } from '../../reading/core/frontmatter';
import { MAX_READING_BYTES, readingUrl, type ReadingItem } from '../../reading/core/model';
import { isGeneratedCapturePath, readingCapturePath } from '../../reading/core/filename';
import { filterUniqueReadingIds, findSavedReadingLink } from '../../reading/core/inventory';
import { portablePathKey } from '@/protocol/portable-path';
import { encryptedInventoryPages, parseEncryptedInventoryPage, type EncryptedInventoryFile as WireFile, MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES, openVerifiedInventoryFile } from '@/encryption/file-inventory';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { trimContentCache } from '@/pwa/storage/content-cache';
import { responseError } from '@/pwa/connection/response-error';
import type { PathTags } from '@/encryption/path-tags';
import { resolveEncryptedPath } from '@/encryption/path-binding';
import { acceptsSealedNote } from './sealed-notes';

// The documented device budget: each refresh seals the whole list and index.
export const MAX_READING_FILES = 10_000;
const MAX_READING_METADATA_BYTES = 12 * 1024 * 1024;
// Changed notes download in parallel, a few at a time, in page order.
const SOURCE_CONCURRENCY = 6;
const DUPLICATE_ID_ISSUE = 'Several notes have this Reading ID. Resolve the duplicates in Obsidian.';
const SEALED_ISSUE = 'The server created a note that would replace or take the name of another note. It was not opened.';
/** `revision` fingerprints the Reading files and issues, so edits elsewhere in the vault keep it. */
interface EncryptedReadingInventory { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: null; revision: string }

/** `hash` is the authenticated plaintext hash; `sealed` marks a note the server sealed. */
interface Source { file: WireFile; content: string; item: ReadingItem; hash: string; sealed: boolean }
/** Authenticated metadata for one encrypted note, reusable while its file is unchanged.
 * `file.path` is the server path; `item.path` is the note's plaintext path. `hash` is
 * its plaintext hash. */
export interface EncryptedReadingIndexEntry { file: WireFile; item: ReadingItem; hash: string }
/** `rejected` marks an attempt the Worker refused with `version_conflict`; it is rebuilt, never resent. */
interface Attempt { requestHash: string; body: string; generation: number; rejected?: true }
interface EncryptedReadingOptions {
	/** The plaintext Reading folder; requests name `wireFolder`, its server form. */
	folderPath: string; wireFolder: string; paths: PathTags; generation: number; authority: FileEncryptionAuthority;
	captureArticle?(url: string): Promise<CapturedArticle>;
	request(path: string, body?: string): Promise<Response>;
	readAttempt(id: string): Promise<unknown>;
	writeAttempt(id: string, attempt: Attempt): Promise<void>;
	/** Optional local copy of the index, so a reload only downloads changed notes. */
	loadIndex?(): Promise<EncryptedReadingIndexEntry[] | undefined>;
	saveIndex?(entries: EncryptedReadingIndexEntry[]): Promise<void>;
	error(message: string, status: number, code?: string): Error;
}
/** A note download that failed in transit. Unlike a rejected note, it is retried
 * even when the vault sequence has not changed. */
class NoteUnavailableError extends Error {}

const known = (entry: EncryptedReadingIndexEntry) => ({ wire: entry.file.path, path: entry.item.path, hash: entry.hash });

function sameFile(a: WireFile, b: WireFile): boolean {
	return a.revision === b.revision && a.hash === b.hash && a.size === b.size;
}

// Unchanged notes keep their item object across inventories, so measure each once.
const metadataSizes = new WeakMap<ReadingItem, number>();
function metadataSize(item: ReadingItem): number {
	let size = metadataSizes.get(item);
	if (size === undefined) { size = new TextEncoder().encode(JSON.stringify(item)).length; metadataSizes.set(item, size); }
	return size;
}

/** Plaintext only exists in the trusted client. Every dispatched mutation is
 * persisted as exact ciphertext first, including its authenticated receipt. */
export class EncryptedReadingApi {
	private sources = new Map<string, Source>();
	private files = new Map<string, WireFile>();
	private indexed = new Map<string, EncryptedReadingIndexEntry>();
	// Server path of each note by its plaintext path, from the last inventory.
	private wires = new Map<string, string>();
	// What the last inventory's issues hide from its listed items: every readable note,
	// including those sharing a Reading ID, and each unreadable note's last verified ID.
	private library: { readable: ReadingItem[]; duplicateIds: Set<string>; unreadable: Array<string | undefined> } = { readable: [], duplicateIds: new Set(), unreadable: [] };
	private indexLoaded = false;
	// The last complete inventory and the vault sequence it was confirmed at. An
	// unchanged first page answers from it, so polling is one request.
	private confirmed?: { sequence: number; result: EncryptedReadingInventory };
	constructor(private options: EncryptedReadingOptions) {}
	private async json<T>(path: string, body?: string): Promise<T> {
		const response = await this.options.request(path, body);
		if (!response.ok) {
			const { message, code } = await responseError(response, 'Reading request failed.');
			throw this.options.error(message, response.status, code);
		}
		return await response.json() as T;
	}
	// 'reminder' is the shared envelope purpose for operation objects in every scope, Reading
	// included. The plugin binds it into each protected header, so it is a wire value, not a
	// feature label: renaming it here breaks decryption with the plugin and stored ciphertext.
	private context(id: string) { return { vaultId: this.options.authority.vaultId, scopeId: this.options.authority.scopeId, objectId: id, purpose: 'reminder' as const }; }
	private async source(file: WireFile, sources = this.sources): Promise<Source> {
		const folder = encodeURIComponent(this.options.wireFolder);
		let source = sources.get(file.path);
		if (!source || !sameFile(source.file, file)) {
			if (file.size > MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES) throw new Error('This Reading note is too large.');
			const response = await this.options.request(`/reading/encrypted-file?folderPath=${folder}&path=${encodeURIComponent(file.path)}&revision=${encodeURIComponent(file.revision)}`).catch(() => undefined);
			if (!response?.ok) throw new NoteUnavailableError('Article changed or is unavailable. Refresh to retry.');
			const reading = { plain: this.options.folderPath, wire: this.options.wireFolder };
			let sealed = false;
			const opened = await openVerifiedInventoryFile(new Uint8Array(await response.arrayBuffer()), file, this.options.authority,
				'Encrypted article failed integrity verification.', (metadataPath, isSealed) => { sealed = isSealed; return resolveEncryptedPath(this.options.paths, file.path, metadataPath, sealed, reading); });
			if (opened.content.byteLength > MAX_READING_BYTES) throw new Error('Reading notes must be smaller than 1 MB.');
			const content = new TextDecoder('utf-8', { fatal: true }).decode(opened.content);
			const metadata = parseReadingNote(content);
			if (!metadata) throw new Error('Open Obsidian to import this note into Reading.');
			source = { file, content, item: { ...metadata, path: opened.metadata.path }, hash: opened.metadata.hash, sealed };
		}

		sources.set(file.path, source);
		trimContentCache(sources, 100);
		return source;
	}
	private async inventory(): Promise<EncryptedReadingInventory> {
		const folder = encodeURIComponent(this.options.wireFolder);
		const fetchPage = async (after?: string) => parseEncryptedInventoryPage(await this.json(`/reading/encrypted-files?folderPath=${folder}${after ? '&after=' + encodeURIComponent(after) : ''}`), this.options.wireFolder, this.options.generation);
		const first = await fetchPage();
		if (this.confirmed?.sequence === first.sequence) return this.confirmed.result;
		if (!this.indexLoaded) {
			this.indexLoaded = true;
			try { if (!this.indexed.size) for (const entry of await this.options.loadIndex?.() ?? []) this.indexed.set(entry.file.path, entry); }
			catch { /* A missing or unreadable local index only costs downloads. */ }
		}
		const candidates: ReadingItem[] = [], unreadable: Array<string | undefined> = [];
		const next = new Map<string, WireFile>(), issues: Array<{ path: string; message: string }> = [];
		const nextIndex = new Map<string, EncryptedReadingIndexEntry>();
		// Sealed notes first seen at a server path in this inventory; checked for taken names once all are listed.
		const newSealed: WireFile[] = [];
		let downloaded = false, unavailable = false;
		const nextSources = new Map(this.sources);
		let metadataBytes = 0;
		for await (const page of encryptedInventoryPages(fetchPage, {
			maxFiles: MAX_READING_FILES, first, confirm: true,
			changed: () => new Error('Reading changed while loading. Refresh again.'),
		})) {
			const loaded = await mapBounded(page.files, SOURCE_CONCURRENCY, async file => {
				const cached = this.indexed.get(file.path);
				if (cached && sameFile(cached.file, file)) return { entry: cached };
				try { const { item, hash, sealed } = await this.source(file, nextSources); downloaded = true; return { entry: { file, item, hash }, sealed }; }
				catch (error) { return { error }; }
			});
			for (const [index, file] of page.files.entries()) {
				try {
					next.set(file.path, file);
					const result = loaded[index]!;
					if ('error' in result) throw result.error;
					const { entry } = result, { item } = entry;
					if (result.sealed) {
						// The server may only create notes, so a sealed one may not replace a note known here.
						const held = this.indexed.get(file.path);
						if (held && !acceptsSealedNote(known(entry), [known(held)])) {
							nextSources.delete(file.path);
							throw new Error(SEALED_ISSUE);
						}
						if (!held) newSealed.push(file);
					}
					metadataBytes += metadataSize(item);
					if (metadataBytes > MAX_READING_METADATA_BYTES) throw new Error('Reading metadata exceeds this device’s library limit.');
					candidates.push(item);
					nextIndex.set(file.path, entry);
				} catch (error) {
					if (error instanceof NoteUnavailableError) unavailable = true;
					// Name a note this device has read before by its plaintext path, so the
					// offline cache keeps its last verified copy and the user can find it.
					// Its entry stays indexed (but unlisted) to keep that name for later failures.
					const previous = this.indexed.get(file.path);
					if (previous) nextIndex.set(file.path, previous);
					unreadable.push(previous?.item.crate_reading_id);
					issues.push({ path: previous?.item.path ?? file.path, message: error instanceof Error ? error.message : 'Article could not be opened.' });
				}
			}
			// An oversized library fails after its last page, before the sequence is confirmed.
			if (!page.nextCursor && metadataBytes > MAX_READING_METADATA_BYTES) throw new Error('Reading metadata exceeds this device’s library limit.');
		}
		// Nor may it take the name of another note, listed now or kept from a failed download.
		for (const file of newSealed) {
			const entry = nextIndex.get(file.path);
			if (!entry || acceptsSealedNote(known(entry), [...nextIndex.values()].filter(other => other !== entry).map(known))) continue;
			nextIndex.delete(file.path); nextSources.delete(file.path);
			candidates.splice(candidates.indexOf(entry.item), 1);
			unreadable.push(undefined);
			issues.push({ path: file.path, message: SEALED_ISSUE });
		}
		const { sequence } = first;
		const removed = [...this.indexed.keys()].some(path => !nextIndex.has(path));
		this.files = next;
		this.indexed = nextIndex;
		this.wires = new Map([...nextIndex.values()].map(entry => [entry.item.path, entry.file.path]));
		for (const path of nextSources.keys()) if (!next.has(path)) nextSources.delete(path);
		this.sources = nextSources;
		const { unique: items, duplicates } = filterUniqueReadingIds(candidates);
		for (const item of duplicates) issues.push({ path: item.path, message: DUPLICATE_ID_ISSUE });
		this.library = { readable: candidates, duplicateIds: new Set(duplicates.map(item => item.crate_reading_id)), unreadable };
		// Unrelated vault edits advance the sequence; an unchanged fingerprint lets
		// callers keep their saved library instead of rewriting and redrawing it.
		const fingerprint = JSON.stringify([[...next.values()].map(file => [file.path, file.revision, file.hash, file.size]), issues.map(issue => [issue.path, issue.message])]);
		const revision = `"e2ee-reading-${this.options.generation}-${(await sha256Hex(fingerprint)).slice(0, 32)}"`;
		const result: EncryptedReadingInventory = this.confirmed?.result.revision === revision ? this.confirmed.result : { items, issues, cursor: null, revision };
		if (!unavailable) this.confirmed = { sequence: sequence, result };
		if (downloaded || removed) await this.options.saveIndex?.([...nextIndex.values()]).catch(() => { /* The index is only a cache. */ });
		return result;
	}
	async request(path: string, rawBody?: string): Promise<unknown> {
		const url = new URL(path, 'https://crate.invalid'), action = url.pathname.slice('/reading/'.length);
		if (action === 'list') return this.inventory();
		if (action === 'item') {
			const list = await this.inventory(), id = url.searchParams.get('id');
			const item = list.items.find(item => item.crate_reading_id === id);
			if (!item) throw this.options.error('Article is unavailable or has an identity conflict.', 409, 'reading_conflict');
			return { item, markdown: readReadingFrontmatter((await this.source(this.files.get(this.wires.get(item.path)!)!)).content)!.body };
		}
		if (!rawBody || !['capture', 'update', 'retry'].includes(action)) throw new Error('Unsupported encrypted Reading request.');
		const body = JSON.parse(rawBody) as Record<string, unknown>, id = body.operationId;
		if (typeof id !== 'string') throw new Error('A saved Reading operation ID is required.');
		const requestHash = await sha256Hex(JSON.stringify({ action, body }));
		const saved = await this.options.readAttempt(id) as Attempt | undefined;
		if (saved && (saved.requestHash !== requestHash || typeof saved.body !== 'string')) throw new Error('This encrypted Reading attempt belongs to a different change.');
		let attempt = saved;
		// Other keys can no longer publish, so this attempt never committed. Rebuild it
		// against current files, preserving the operation ID.
		if (attempt && attempt.generation !== this.options.generation) attempt = undefined;
		for (let rebuilt = false; ; rebuilt = true) {
			if (!attempt || attempt.rejected) {
				const prepared = await this.prepare(action, body, id, rawBody, requestHash);
				if ('response' in prepared) return prepared.response;
				attempt = prepared.attempt;
			}
			const response = await this.options.request('/reading/encrypted-commit', attempt.body);
			const result = await response.json() as { encrypted?: string; error?: string; code?: string };
			if (response.status === 409 && result.code === 'version_conflict') {
				// The Worker replays a committed copy of this operation before reporting a
				// conflict, so the immutable attempt never committed. Rebuild it once against
				// the current note under the same operation ID; a second conflict needs review.
				attempt = { ...attempt, rejected: true };
				await this.options.writeAttempt(id, attempt);
				if (rebuilt) throw this.options.error(result.error ?? 'A note changed. Refresh before retrying.', response.status, result.code);
				continue;
			}
			if (!response.ok || typeof result.encrypted !== 'string') throw this.options.error(result.error ?? 'Reading request failed.', response.status, result.code);
			const receipt = await decryptJson(result.encrypted, this.options.authority.key, this.context(id)) as { requestHash: string; response: unknown };
			if (receipt.requestHash !== requestHash) throw new Error('The encrypted Reading acknowledgment does not match this change.');
			// Other decrypted notes stay valid; `sameFile` rejects any that changed elsewhere.
			const committed = JSON.parse(attempt.body) as { files: Array<{ path: string }>; remove?: Array<{ path: string }> };
			for (const file of [...committed.files, ...committed.remove ?? []]) this.sources.delete(file.path);
			return receipt.response;
		}
	}
	/** Build and persist exact ciphertext for one operation against the current
	 * library, or answer from a receipt the operation already committed. */
	private async prepare(action: string, body: Record<string, unknown>, id: string, rawBody: string, requestHash: string): Promise<{ attempt: Attempt } | { response: unknown }> {
		const list = await this.inventory(), { readable, duplicateIds, unreadable } = this.library;
		// An unreadable note may be a failed download, so a change it blocks stays queued
		// and retries; a rejection here would strand it for review once the note recovers.
		const unavailable = (message = 'Refresh or resolve unreadable Reading notes before saving changes.') => this.options.error(message, 503, 'reading_unavailable');
		let path = '', wire = '', content: string, previous: WireFile | undefined, itemId: string, before: ReadingItem | undefined;
		if (action === 'capture') {
			// Any unreadable note may already save this link; a new note would duplicate it.
			if (unreadable.length) throw unavailable();
			const link = readingUrl(body.url), saved = findSavedReadingLink(readable, link);
			if (saved.kind === 'many') throw this.options.error('Several notes already save this link.', 409);
			if (saved.kind === 'one') {
				if (duplicateIds.has(saved.item.crate_reading_id)) throw unavailable(DUPLICATE_ID_ISSUE);
				return { response: { saved: true, alreadySaved: true, id: saved.item.crate_reading_id } };
			}
			// Stable even if preparation is interrupted before ciphertext persistence.
			itemId = typeof body.captureId === 'string' ? body.captureId : await readingImportId(id, rawBody);
			content = createReadingNote({ id: itemId, url: link, title: typeof body.title === 'string' ? body.title : undefined, savedAt: new Date().toISOString() });
			if (body.fetchArticle === false) content = patchReadingFrontmatter(content, { extraction_status: 'unavailable' });
		} else {
			// Never choose between notes sharing the target's ID.
			if (typeof body.id === 'string' && duplicateIds.has(body.id)) throw unavailable(DUPLICATE_ID_ISSUE);
			const item = list.items.find(item => item.crate_reading_id === body.id);
			// An unreadable note may be the target: one last verified with its ID, or any
			// note when the target is not listed. Other unreadable notes do not block it.
			if (unreadable.length && (!item || unreadable.includes(item.crate_reading_id))) throw unavailable();
			if (!item) throw this.options.error('This article moved or was deleted.', 409, 'reading_conflict');
			wire = this.wires.get(item.path)!;
			const source = await this.source(this.files.get(wire)!); path = item.path; previous = source.file; itemId = item.crate_reading_id; before = item;
			if (action === 'retry') {
				if (!isEmptyReadingCapture(source.content, item)) throw this.options.error('Only empty saved links can be downloaded.', 409);
				content = patchReadingFrontmatter(source.content, { extraction_status: 'pending' });
			}
			else {
				if (!body.changes || typeof body.changes !== 'object' || !body.before || typeof body.before !== 'object') throw new Error('Choose a Reading change.');
				if (readingUpdateIssue(item, body.before, body.changes)) throw this.options.error('This article changed on another device. Refresh before editing.', 409, 'reading_conflict');
				content = updateReadingNote(source.content, itemId, body.changes);
			}
		}
		if ((action === 'capture' && body.fetchArticle !== false || action === 'retry') && this.options.captureArticle) {
			const item = parseReadingNote(content)!;
			try {
				const article = await this.options.captureArticle(item.source_url);
				content = applyLocalArticle(patchReadingFrontmatter(content, { extraction_status: 'unavailable' }), { ...item, path }, article);
			} catch { content = patchReadingFrontmatter(content, { extraction_status: 'unavailable' }); }
		}
		// Notes are named after the article once its title is known; a name the user chose is kept.
		const saved = parseReadingNote(content)!, source = { title: saved.title, url: saved.source_url };
		// Notes sharing a Reading ID are unlisted but still own their names.
		const occupied = (candidate: string) => readable.some(item => item.crate_reading_id !== itemId && portablePathKey(item.path) === portablePathKey(candidate));
		let removed: WireFile | undefined;
		if (action === 'capture') {
			path = await readingCapturePath(this.options.folderPath, source, itemId, occupied);
			wire = await this.options.paths.wire(path);
		} else if (action === 'retry' && before && saved.title !== before.title
			&& isGeneratedCapturePath(path, this.options.folderPath, { title: before.title, url: before.source_url }, itemId)) {
			const renamed = await readingCapturePath(this.options.folderPath, source, itemId, occupied);
			if (renamed !== path) { removed = previous; previous = undefined; path = renamed; wire = await this.options.paths.wire(renamed); }
		}
		const sealed = await sealFile({ path, content: new TextEncoder().encode(content), contentType: 'text/markdown', publicData: null }, this.options.authority);
		const response = { saved: true, id: itemId };
		const acknowledgment = await encryptJson({ requestHash, response }, this.options.authority.key, this.context(id));
		const attempt: Attempt = { requestHash, generation: this.options.generation, body: JSON.stringify({ folderPath: this.options.wireFolder, operationId: id,
			files: [{ path: wire, content: new TextDecoder().decode(sealed.bytes), expectedHash: previous?.hash ?? null, ...(previous ? { expectedRevision: previous.revision } : {}) }],
			...(removed ? { remove: [{ path: removed.path, expectedHash: removed.hash, expectedRevision: removed.revision }] } : {}), acknowledgment }) };
		await this.options.writeAttempt(id, attempt);
		return { attempt };
	}
}
