import { applyLocalArticle } from '../../reading/core/article';
import { planReadingFileCommand, readingFileCommandRefusal } from '../../reading/core/reading-file-command';
import type { CapturedArticle } from '../../reading/extraction/types';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { decryptJson, encryptJson } from '@/encryption/envelope';
import { createReadingNote, parseReadingNote, readingImportId } from '../../reading/core/notes';
import { readReadingFrontmatter, patchReadingFrontmatter } from '../../reading/core/frontmatter';
import { MAX_READING_BYTES, readingUrl, type ReadingItem } from '../../reading/core/model';
import { readingCapturePath, retitledCapturePath } from '../../reading/core/filename';
import { filterUniqueReadingIds, findSavedReadingLink, READING_DUPLICATE_ID_ISSUE } from '../../reading/core/inventory';
import { portablePathKey } from '@/protocol/portable-path';
import { ENCRYPTED_INVENTORY_PAGE, encryptedInventoryPages, parseEncryptedInventoryPage, type EncryptedInventoryFile as WireFile, MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES, sameInventoryFile } from '@/encryption/file-inventory';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { trimContentCache } from '@/pwa/storage/content-cache';
import { responseError } from '@/pwa/connection/response-error';
import type { PathTags } from '@/encryption/path-tags';
import { sealedNoteRefusal, type KnownNote } from '@/encryption/sealed-note';
import { indexedCards, refreshCardIndex, type CardIndexState } from './encrypted-card-index';
import type { ReadingIndexCard } from '@/reading/core/card-index';
import type { StoredCardIndex } from './storage/cache';
import { encryptedFilePath, encryptedFilesPath, encryptedOperationContext, openEncryptedNote, postEncryptedCommit } from '../encryption/encrypted-folder-client';

// The documented device budget: each refresh seals the whole list and index. A larger
// library lists every file but opens only its most recently changed notes.
export const MAX_READING_FILES = 10_000;
// File entries listed per refresh, the same bound as the unencrypted library.
const MAX_READING_INVENTORY_FILES = 100_000;
const MAX_READING_METADATA_BYTES = 12 * 1024 * 1024;
// Changed notes download in parallel, a few at a time, in page order.
const SOURCE_CONCURRENCY = 6;
const SEALED_ISSUE = 'The server created a note that would replace or take the name of another note. It was not opened.';
const OUTDATED_ISSUE = 'Open Obsidian to update this library. Recent changes from other devices may be missing.';
// Article opens reuse the last confirmed inventory this long; a list refresh or a commit reads it again.
const ITEM_INVENTORY_REUSE_MS = 30_000;
/** `revision` fingerprints the Reading files and issues, so edits elsewhere in the vault keep it.
 * `omitted` counts older notes left out because the library exceeds this device's limit. */
interface EncryptedReadingInventory { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: null; revision: string; omitted?: number }

/** The most recently changed files first, by the server's write time; ties keep path order. */
function newestFiles(files: WireFile[], limit: number): WireFile[] {
	if (files.length <= limit) return files;
	return [...files].sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? '') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
}

/** `hash` is the authenticated plaintext hash; `sealed` marks a note the server sealed. */
interface Source { file: WireFile; content: string; item: ReadingItem; hash: string; sealed: boolean }
/** Authenticated metadata for one encrypted note, reusable while its file is unchanged.
 * `file.path` is the server path; `item.path` is the note's plaintext path. `hash` is
 * its plaintext hash. */
export interface EncryptedReadingIndexEntry { file: WireFile; item: ReadingItem; hash: string }
/** `rejected` marks an attempt the Worker refused with `version_conflict`; it is rebuilt, never resent. */
interface Attempt { requestHash: string; body: string; generation: number; rejected?: true }
/** What `prepare` commits: the answer when nothing needs writing, a note removal, or a
 * note write. A capture has no path until its note is named. */
type PreparedPlan =
	| { response: unknown }
	| { kind: 'remove'; itemId: string; file: WireFile }
	| { kind: 'write'; itemId: string; content: string; path: string; wire: string; previous?: WireFile; before?: ReadingItem };
interface EncryptedReadingOptions {
	/** The plaintext Reading folder; requests name `wireFolder`, its server form. */
	folderPath: string; wireFolder: string; paths: PathTags; generation: number; authority: FileEncryptionAuthority;
	captureArticle?(url: string): Promise<CapturedArticle>;
	request(path: string, body?: string, headers?: Record<string, string>): Promise<Response>;
	readAttempt(id: string): Promise<unknown>;
	writeAttempt(id: string, attempt: Attempt): Promise<void>;
	/** Optional local copy of the index, so a reload only downloads changed notes. */
	loadIndex?(): Promise<EncryptedReadingIndexEntry[] | undefined>;
	saveIndex?(entries: EncryptedReadingIndexEntry[]): Promise<void>;
	/** The card index kept from the last visit, and saving it after a change. */
	loadCardIndex?(): Promise<{ state: StoredCardIndex; shards: Map<string, ReadingIndexCard[]> } | undefined>;
	saveCardIndex?(state: StoredCardIndex, shards: ReadonlyMap<string, ReadingIndexCard[]>, added: ReadonlySet<string>): Promise<void>;
	isCard?(value: unknown): value is ReadingIndexCard;
	error(message: string, status: number, code?: string): Error;
}
/** A note download that failed in transit. Unlike a rejected note, it is retried
 * even when the vault sequence has not changed. */
class NoteUnavailableError extends Error {}

/** Reading routes this client answers; an encrypted session never sends them in plaintext. */
export const ENCRYPTED_READING_ACTIONS: readonly string[] = ['list', 'item', 'capture', 'update', 'retry', 'delete'];

const known = (entry: EncryptedReadingIndexEntry) => ({ wire: entry.file.path, path: entry.item.path, hash: entry.hash });

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
	// The card index, while the server has one; the inventory listing is used otherwise.
	private cardIndex?: CardIndexState;
	private cardIndexLoaded = false;
	private cardIndexSaved?: string;
	// Changed notes opened from the tail, by server path, reused while their file is unchanged.
	private cardEntries = new Map<string, EncryptedReadingIndexEntry>();
	// The last complete inventory and the vault sequence it was confirmed at. An
	// unchanged first page answers from it, so polling is one request.
	private confirmed?: { sequence: number; result: EncryptedReadingInventory };
	// When the files and paths above last matched `confirmed`, so an article open can skip the inventory.
	private confirmedAt?: number;
	constructor(private options: EncryptedReadingOptions) {}
	private async json<T>(path: string, body?: string): Promise<T> {
		const response = await this.options.request(path, body);
		if (!response.ok) {
			const { message, code } = await responseError(response, 'Reading request failed.');
			throw this.options.error(message, response.status, code);
		}
		return await response.json() as T;
	}
	private context(id: string) { return encryptedOperationContext(this.options.authority.vaultId, this.options.authority.scopeId, id); }
	private async source(file: WireFile, sources = this.sources): Promise<Source> {
		let source = sources.get(file.path);
		if (!source || !sameInventoryFile(source.file, file)) {
			if (file.size > MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES) throw new Error('This Reading note is too large.');
			const response = await this.options.request(encryptedFilePath('/reading', this.options.wireFolder, file)).catch(() => undefined);
			if (!response?.ok) throw new NoteUnavailableError('Article changed or is unavailable. Refresh to retry.');
			const { opened, sealed } = await openEncryptedNote(response, file, { authority: this.options.authority, integrityError: 'Encrypted article failed integrity verification.',
				paths: this.options.paths, sealedFolder: { plain: this.options.folderPath, wire: this.options.wireFolder } });
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
	/** The library from the card index when the server has one, else from the file listing. */
	private async inventory(): Promise<EncryptedReadingInventory> {
		return await this.indexInventory() ?? this.listInventory();
	}
	/**
	 * The card index's library: cards from the shards, with the notes changed since the
	 * manifest's basis downloaded and opened. Costs a conditional manifest read and a tail
	 * of rows for the changes since the last refresh, however large the library is.
	 */
	private async indexInventory(): Promise<EncryptedReadingInventory | null> {
		if (!this.options.isCard) return null;
		if (!this.cardIndexLoaded) {
			this.cardIndexLoaded = true;
			try {
				const stored = await this.options.loadCardIndex?.();
				if (stored) {
					const { state, shards } = stored;
					this.cardIndex = { etag: state.etag, httpEtag: state.httpEtag, manifest: state.manifest, lastSeq: state.lastSeq, shards, outdated: false,
						overlay: new Map<string, WireFile | null>([...state.overlay.map(entry => [entry.file.path, entry.file] as const), ...state.removed.map(path => [path, null] as const)]) };
					this.cardEntries = new Map(state.overlay.map(entry => [entry.file.path, entry]));
				}
			} catch { /* A missing or unreadable local copy only costs downloads. */ }
		}
		const refreshed = await refreshCardIndex({ request: (path, headers) => this.options.request(path, undefined, headers), keys: { vaultId: this.options.authority.vaultId, key: this.options.authority.key, keyGeneration: this.options.generation },
			wireFolder: this.options.wireFolder, generation: this.options.generation, isCard: (value): value is ReadingIndexCard => this.options.isCard!(value), error: (message, status, code) => this.options.error(message, status, code) }, this.cardIndex);
		if (!refreshed) { this.cardIndex = undefined; return null; }
		const { state, added } = refreshed;
		const cards = indexedCards(state);
		// Listed notes, for the sealed-note rule; a server write at a listed path replaces it.
		const listed: KnownNote[] = [...cards.values()].map(card => ({ wire: card.wire!, path: card.path, hash: '' }));
		const changed = [...state.overlay].flatMap(([wire, file]) => file ? [[wire, file] as const] : []);
		const loaded = await mapBounded(changed, SOURCE_CONCURRENCY, async ([wire, file]) => {
			const cached = this.cardEntries.get(wire);
			if (cached && sameInventoryFile(cached.file, file)) return { entry: cached, sealed: false };
			try { const { item, hash, sealed } = await this.source(file); return { entry: { file, item, hash }, sealed }; }
			catch (error) { return { error }; }
		});
		const candidates: ReadingItem[] = [], unreadable: Array<string | undefined> = [], issues: Array<{ path: string; message: string }> = [];
		const wires = new Map<string, string>(), files = new Map<string, WireFile>(), entries = new Map<string, EncryptedReadingIndexEntry>();
		let unavailable = false;
		for (const [index, [wire]] of changed.entries()) {
			const result = loaded[index]!, card = cards.get(wire);
			if ('error' in result) {
				if (result.error instanceof NoteUnavailableError) unavailable = true;
				unreadable.push(card?.crate_reading_id);
				issues.push({ path: card?.path ?? wire, message: result.error instanceof Error ? result.error.message : 'Article could not be opened.' });
				continue;
			}
			// The server may only create sealed notes, never replace or rename into another.
			if (result.sealed && sealedNoteRefusal(known(result.entry), listed)) {
				unreadable.push(undefined);
				issues.push({ path: wire, message: SEALED_ISSUE });
				continue;
			}
			entries.set(wire, result.entry);
		}
		for (const [wire, card] of cards) {
			if (state.overlay.has(wire)) continue;
			const { wire: _wire, ...item } = card;
			candidates.push(item); wires.set(item.path, wire);
		}
		for (const [wire, entry] of entries) { candidates.push(entry.item); wires.set(entry.item.path, wire); files.set(wire, entry.file); }
		if (state.outdated) issues.push({ path: this.options.folderPath, message: OUTDATED_ISSUE });
		const { unique: items, duplicates } = filterUniqueReadingIds(candidates);
		for (const item of duplicates) issues.push({ path: item.path, message: READING_DUPLICATE_ID_ISSUE });
		this.library = { readable: candidates, duplicateIds: new Set(duplicates.map(item => item.crate_reading_id)), unreadable };
		this.wires = wires; this.files = files; this.cardEntries = entries; this.cardIndex = state;
		const fingerprint = JSON.stringify([state.etag, [...state.overlay].map(([wire, file]) => [wire, file?.revision ?? null]), issues.map(issue => [issue.path, issue.message])]);
		const revision = `"e2ee-index-${this.options.generation}-${(await sha256Hex(fingerprint)).slice(0, 32)}"`;
		const result: EncryptedReadingInventory = this.confirmed?.result.revision === revision ? this.confirmed.result : { items, issues, cursor: null, revision };
		this.confirmed = { sequence: state.lastSeq, result };
		this.confirmedAt = unavailable ? undefined : Date.now();
		const saved = JSON.stringify([revision, state.lastSeq]);
		if (this.options.saveCardIndex && (added.size || this.cardIndexSaved !== saved)) {
			this.cardIndexSaved = saved;
			await this.options.saveCardIndex({ version: 1, identity: '', etag: state.etag, httpEtag: state.httpEtag, manifest: state.manifest, lastSeq: state.lastSeq,
				overlay: [...entries.values()], removed: [...state.overlay].flatMap(([wire, file]) => file ? [] : [wire]) }, state.shards, added).catch(() => { /* Only a cache. */ });
		}
		return result;
	}
	/** A file's current server entry. With the card index, read now for that one note. */
	private async fileFor(wire: string): Promise<WireFile> {
		if (!this.cardIndex) return this.files.get(wire)!;
		const response = await this.options.request(`/reading/index/file?path=${encodeURIComponent(wire)}`);
		if (response.status === 404) throw this.options.error('This article moved or was deleted.', 409, 'reading_conflict');
		const answer = await response.json().catch(() => null) as { file?: unknown } | null;
		if (!response.ok || !answer) throw this.options.error('Reading request failed.', response.status);
		const [file] = parseEncryptedInventoryPage({ files: [answer.file], nextCursor: null, sequence: 0, generation: this.options.generation }, this.options.wireFolder, this.options.generation).files;
		this.files.set(wire, file!);
		return file!;
	}
	private async listInventory(): Promise<EncryptedReadingInventory> {
		const fetchPage = async (after?: string) => parseEncryptedInventoryPage(await this.json(encryptedFilesPath('/reading', this.options.wireFolder, after)), this.options.wireFolder, this.options.generation);
		const first = await fetchPage();
		if (this.confirmed?.sequence === first.sequence) { if (this.confirmedAt !== undefined) this.confirmedAt = Date.now(); return this.confirmed.result; }
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
		const changed = () => new Error('Reading changed while loading. Refresh again.');
		// The inventory is small metadata, so it is listed whole; only the most recently changed
		// notes, up to this device's file and metadata limits, are downloaded and opened.
		const listed: WireFile[] = [];
		for await (const page of encryptedInventoryPages(fetchPage, { maxFiles: MAX_READING_INVENTORY_FILES, first, changed })) listed.push(...page.files);
		const chosen = newestFiles(listed, MAX_READING_FILES);
		let omitted = listed.length - chosen.length, metadataBytes = 0, full = false;
		for (let offset = 0; offset < chosen.length && !full; offset += ENCRYPTED_INVENTORY_PAGE) {
			const batch = chosen.slice(offset, offset + ENCRYPTED_INVENTORY_PAGE);
			const loaded = await mapBounded(batch, SOURCE_CONCURRENCY, async file => {
				const cached = this.indexed.get(file.path);
				if (cached && sameInventoryFile(cached.file, file)) return { entry: cached };
				try { const { item, hash, sealed } = await this.source(file, nextSources); downloaded = true; return { entry: { file, item, hash }, sealed }; }
				catch (error) { return { error }; }
			});
			for (const [index, file] of batch.entries()) {
				const result = loaded[index]!;
				// Notes past the metadata budget are older than every note kept; Obsidian still has them.
				if (full || !('error' in result) && metadataBytes + metadataSize(result.entry.item) > MAX_READING_METADATA_BYTES) { full = true; omitted++; continue; }
				try {
					next.set(file.path, file);
					if ('error' in result) throw result.error;
					const { entry } = result, { item } = entry;
					if (result.sealed) {
						// The server may only create notes, so a sealed one may not replace a note known here.
						const held = this.indexed.get(file.path);
						if (held && sealedNoteRefusal(known(entry), [known(held)])) {
							nextSources.delete(file.path);
							throw new Error(SEALED_ISSUE);
						}
						if (!held) newSealed.push(file);
					}
					metadataBytes += metadataSize(item);
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
			if (full) omitted += chosen.length - offset - batch.length;
		}
		// Files read while listing and opening belong to one snapshot.
		if ((await fetchPage()).sequence !== first.sequence) throw changed();
		// Nor may it take the name of another note, listed now or kept from a failed download.
		for (const file of newSealed) {
			const entry = nextIndex.get(file.path);
			if (!entry || !sealedNoteRefusal(known(entry), [...nextIndex.values()].filter(other => other !== entry).map(known))) continue;
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
		for (const item of duplicates) issues.push({ path: item.path, message: READING_DUPLICATE_ID_ISSUE });
		this.library = { readable: candidates, duplicateIds: new Set(duplicates.map(item => item.crate_reading_id)), unreadable };
		// Unrelated vault edits advance the sequence; an unchanged fingerprint lets
		// callers keep their saved library instead of rewriting and redrawing it.
		const fingerprint = JSON.stringify([[...next.values()].map(file => [file.path, file.revision, file.hash, file.size]), issues.map(issue => [issue.path, issue.message]), omitted]);
		const revision = `"e2ee-reading-${this.options.generation}-${(await sha256Hex(fingerprint)).slice(0, 32)}"`;
		const result: EncryptedReadingInventory = this.confirmed?.result.revision === revision ? this.confirmed.result
			: { items, issues, cursor: null, revision, ...(omitted ? { omitted } : {}) };
		if (!unavailable) this.confirmed = { sequence: sequence, result };
		this.confirmedAt = unavailable ? undefined : Date.now();
		if (downloaded || removed) await this.options.saveIndex?.([...nextIndex.values()]).catch(() => { /* The index is only a cache. */ });
		return result;
	}
	async request(path: string, rawBody?: string): Promise<unknown> {
		const url = new URL(path, 'https://crate.invalid'), action = url.pathname.slice('/reading/'.length);
		if (action === 'list') return this.inventory();
		if (action === 'item') return (await this.item(url.searchParams.get('id') ?? ''))!.article;
		if (!rawBody || !ENCRYPTED_READING_ACTIONS.includes(action)) throw new Error('Unsupported encrypted Reading request.');
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
			const outcome = await postEncryptedCommit((path, body) => this.options.request(path, body), '/reading', attempt.body);
			if (outcome.kind === 'conflict') {
				// The immutable attempt never committed. Rebuild it once against the current
				// note under the same operation ID; a second conflict needs review.
				attempt = { ...attempt, rejected: true };
				await this.options.writeAttempt(id, attempt);
				if (rebuilt) throw this.options.error(outcome.answer.error ?? 'A note changed. Refresh before retrying.', outcome.response.status, outcome.answer.code);
				continue;
			}
			if (outcome.kind === 'failed') {
				const { message, code } = outcome.answer
					? { message: outcome.answer.error ?? 'Reading request failed.', code: outcome.answer.code }
					: await responseError(outcome.response, 'Reading request failed.');
				throw this.options.error(message, outcome.response.status, code);
			}
			const receipt = await decryptJson(outcome.encrypted, this.options.authority.key, this.context(id)) as { requestHash: string; response: unknown };
			if (receipt.requestHash !== requestHash) throw new Error('The encrypted Reading acknowledgment does not match this change.');
			// Other decrypted notes stay valid; `sameInventoryFile` rejects any that changed elsewhere.
			const committed = JSON.parse(attempt.body) as { files: Array<{ path: string }>; remove?: Array<{ path: string }> };
			for (const file of [...committed.files, ...committed.remove ?? []]) this.sources.delete(file.path);
			this.confirmedAt = undefined;
			return receipt.response;
		}
	}
	/** One article and its revision ETag, derived from its file. With `savedEtag`, resolves
	 * to null without downloading while that revision is current. A recently confirmed
	 * inventory is reused; a note that changed since is read again from a new one. */
	async item(id: string, savedEtag?: string): Promise<{ article: { item: ReadingItem; markdown: string }; etag: string } | null> {
		const recent = this.confirmed && this.confirmedAt !== undefined && Date.now() - this.confirmedAt < ITEM_INVENTORY_REUSE_MS;
		for (let reused = Boolean(recent); ; reused = false) {
			const list = reused ? this.confirmed!.result : await this.inventory();
			const item = list.items.find(item => item.crate_reading_id === id);
			if (!item && !reused) throw this.options.error('Article is unavailable or has an identity conflict.', 409, 'reading_conflict');
			if (!item) continue;
			const file = await this.fileFor(this.wires.get(item.path)!);
			const etag = `"e2ee-file-${this.options.generation}-${(await sha256Hex(`${file.path}\n${file.revision}\n${file.hash}`)).slice(0, 32)}"`;
			if (etag === savedEtag) return null;
			try { return { article: { item, markdown: readReadingFrontmatter((await this.source(file)).content)!.body }, etag }; }
			catch (error) { if (!reused || !(error instanceof NoteUnavailableError)) throw error; }
		}
	}
	/** Build and persist exact ciphertext for one operation against the current
	 * library, or answer from a receipt the operation already committed. */
	private async prepare(action: string, body: Record<string, unknown>, id: string, rawBody: string, requestHash: string): Promise<{ attempt: Attempt } | { response: unknown }> {
		const list = await this.inventory();
		const plan = action === 'capture' ? await this.planCapture(body, id, rawBody) : await this.planEdit(action, body, list);
		if ('response' in plan) return plan;
		const { itemId } = plan;
		if (plan.kind === 'remove') return { attempt: await this.persistAttempt(id, requestHash, { deleted: true, id: itemId }, [], [plan.file]) };
		let { content, path, wire, previous } = plan;
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
		const occupied = (candidate: string) => this.library.readable.some(item => item.crate_reading_id !== itemId && portablePathKey(item.path) === portablePathKey(candidate));
		let removed: WireFile | undefined;
		if (action === 'capture') {
			path = await readingCapturePath(this.options.folderPath, source, itemId, occupied);
			wire = await this.options.paths.wire(path);
		} else if (action === 'retry' && plan.before) {
			const renamed = await retitledCapturePath(path, this.options.folderPath, { title: plan.before.title, url: plan.before.source_url }, source, itemId, occupied);
			if (renamed) { removed = previous; previous = undefined; path = renamed; wire = await this.options.paths.wire(renamed); }
		}
		const sealed = await sealFile({ path, content: new TextEncoder().encode(content), contentType: 'text/markdown', publicData: null }, this.options.authority);
		const file = { path: wire, content: new TextDecoder().decode(sealed.bytes), expectedHash: previous?.hash ?? null, ...(previous ? { expectedRevision: previous.revision } : {}) };
		return { attempt: await this.persistAttempt(id, requestHash, { saved: true, id: itemId }, [file], removed ? [removed] : []) };
	}
	/** A new note for a captured link, or the answer when a note already saves it. */
	private async planCapture(body: Record<string, unknown>, id: string, rawBody: string): Promise<PreparedPlan> {
		const { readable, duplicateIds, unreadable } = this.library;
		// Any unreadable note may already save this link; a new note would duplicate it.
		if (unreadable.length) throw this.unavailable();
		const link = readingUrl(body.url), saved = findSavedReadingLink(readable, link);
		if (saved.kind === 'many') throw this.options.error('Several notes already save this link.', 409);
		if (saved.kind === 'one') {
			if (duplicateIds.has(saved.item.crate_reading_id)) throw this.unavailable(READING_DUPLICATE_ID_ISSUE);
			return { response: { saved: true, alreadySaved: true, id: saved.item.crate_reading_id } };
		}
		// Stable even if preparation is interrupted before ciphertext persistence.
		const itemId = typeof body.captureId === 'string' ? body.captureId : await readingImportId(id, rawBody);
		let content = createReadingNote({ id: itemId, url: link, title: typeof body.title === 'string' ? body.title : undefined, savedAt: new Date().toISOString() });
		if (body.fetchArticle === false) content = patchReadingFrontmatter(content, { extraction_status: 'unavailable' });
		return { kind: 'write', itemId, content, path: '', wire: '' };
	}
	/** The note an update, retry or delete targets, with its new content or its removal. */
	private async planEdit(action: string, body: Record<string, unknown>, list: EncryptedReadingInventory): Promise<PreparedPlan> {
		const { duplicateIds, unreadable } = this.library;
		// Never choose between notes sharing the target's ID.
		if (typeof body.id === 'string' && duplicateIds.has(body.id)) throw this.unavailable(READING_DUPLICATE_ID_ISSUE);
		const item = list.items.find(item => item.crate_reading_id === body.id);
		// An unreadable note may be the target: one last verified with its ID, or any
		// note when the target is not listed. Other unreadable notes do not block it.
		if (unreadable.length && (!item || unreadable.includes(item.crate_reading_id))) throw this.unavailable();
		if (!item) throw this.options.error('This article moved or was deleted.', 409, 'reading_conflict');
		const wire = this.wires.get(item.path)!;
		const source = await this.source(await this.fileFor(wire));
		const command = action === 'delete' || action === 'retry' ? action : 'update';
		const plan = await planReadingFileCommand(item, source.content, { action: command, before: body.before, changes: body.changes, markdownHash: body.markdownHash });
		if (plan.kind === 'issue') {
			const refusal = readingFileCommandRefusal(plan, command);
			throw this.options.error(refusal.message, refusal.status, refusal.code);
		}
		if (plan.kind === 'remove') return { kind: 'remove', itemId: item.crate_reading_id, file: source.file };
		return { kind: 'write', itemId: item.crate_reading_id, content: plan.content, path: item.path, wire, previous: source.file, before: item };
	}
	/** An unreadable note may be a failed download, so a change it blocks stays queued
	 * and retries; a rejection here would strand it for review once the note recovers. */
	private unavailable(message = 'Refresh or resolve unreadable Reading notes before saving changes.'): Error {
		return this.options.error(message, 503, 'reading_unavailable');
	}
	/** Stores the exact commit body, with the encrypted receipt `response` answers with. */
	private async persistAttempt(id: string, requestHash: string, response: unknown, files: unknown[], remove: WireFile[]): Promise<Attempt> {
		const acknowledgment = await encryptJson({ requestHash, response }, this.options.authority.key, this.context(id));
		const attempt: Attempt = { requestHash, generation: this.options.generation, body: JSON.stringify({ folderPath: this.options.wireFolder, operationId: id, files,
			...(remove.length ? { remove: remove.map(file => ({ path: file.path, expectedHash: file.hash, expectedRevision: file.revision })) } : {}), acknowledgment }) };
		await this.options.writeAttempt(id, attempt);
		return attempt;
	}
}
