import { applyLocalArticle } from '../../reading/core/article';
import { planReadingFileCommand, readingFileCommandRefusal } from '../../reading/core/reading-file-command';
import type { CapturedArticle } from '../../reading/extraction/types';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { decryptJson, encryptJson } from '@/encryption/envelope';
import { createReadingNote, parseReadingNote, readingImportId } from '../../reading/core/notes';
import { readReadingFrontmatter, patchReadingFrontmatter } from '../../reading/core/frontmatter';
import { MAX_READING_BYTES, readingUrl, readingUrlIdentity, type ReadingItem } from '../../reading/core/model';
import { readingCapturePath, retitledCapturePath } from '../../reading/core/filename';
import { READING_DUPLICATE_ID_ISSUE } from '../../reading/core/inventory';
import { normalizedTag, titleMatches } from '../../reading/core/search-terms';
import { openReadingCard, readingCardFields, sameReadingCardFields, sealReadingCard, type ReadingCardFields, type ReadingCardKeys } from '../../reading/core/reading-card';
import { hashedQueryTerms, hashedReadingTerms } from '@/encryption/reading-search';
import { type EncryptedInventoryFile as WireFile, MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES, sameInventoryFile } from '@/encryption/file-inventory';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { trimContentCache } from '@/pwa/storage/content-cache';
import { responseError } from '@/pwa/connection/response-error';
import type { PathTags } from '@/encryption/path-tags';
import { sealedNoteRefusal } from '@/encryption/sealed-note';
import { encryptedFilePath, encryptedOperationContext, openEncryptedNote, postEncryptedCommit } from '../encryption/encrypted-folder-client';

// Notes waiting for a card are opened a few at a time.
const SOURCE_CONCURRENCY = 6;
// One refresh posts at most this many cards; the next refresh continues.
const MAX_FILLED_PER_REFRESH = 500;
// A card post stays under the Worker's body limit.
const MAX_CARD_POST_BYTES = 200 * 1024;
const SEALED_ISSUE = 'The server created a note that would replace or take the name of another note. It was not opened.';

/** `hash` is the authenticated plaintext hash; `sealed` marks a note the server sealed. */
interface Source { file: WireFile; content: string; item: ReadingItem; hash: string; sealed: boolean }
/** A listed note: its current server file and the item its card lists. */
interface Listed { file: WireFile; item: ReadingItem; stale: boolean }
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
	/** Hashes search terms (`src/encryption/reading-search.ts`). */
	searchKey: CryptoKey;
	captureArticle?(url: string): Promise<CapturedArticle>;
	request(path: string, body?: string, headers?: Record<string, string>): Promise<Response>;
	readAttempt(id: string): Promise<unknown>;
	writeAttempt(id: string, attempt: Attempt): Promise<void>;
	error(message: string, status: number, code?: string): Error;
}
/** A note download that failed in transit. Unlike a rejected note, it is retried. */
class NoteUnavailableError extends Error {}

/** Reading routes this client answers; an encrypted session never sends them in plaintext. */
export const ENCRYPTED_READING_ACTIONS: readonly string[] = ['items', 'item', 'capture', 'update', 'retry', 'delete'];

interface ItemsPage { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: string | null }
interface StaleFile extends WireFile { card?: string }

/**
 * Plaintext only exists in the trusted client. The server lists encrypted cards a page at a
 * time; this client opens them, posts cards for notes that changed (`fill`), and persists
 * every mutation as exact ciphertext first, including its authenticated receipt.
 */
export class EncryptedReadingApi {
	private sources = new Map<string, Source>();
	// Notes this client listed, by Reading ID, so an open or an edit finds its file.
	private listed = new Map<string, Listed>();
	// Notes that could not be opened or were refused at the last fill, by server path.
	private unreadable = new Map<string, { message: string; id?: string }>();
	private filling?: Promise<void>;
	constructor(private options: EncryptedReadingOptions) {}
	private get cardKeys(): ReadingCardKeys { return { vaultId: this.options.authority.vaultId, key: this.options.authority.key, keyGeneration: this.options.generation }; }
	private async json<T>(path: string, body?: string): Promise<T> {
		const response = await this.options.request(path, body);
		if (!response.ok) {
			const { message, code } = await responseError(response, 'Reading request failed.');
			throw this.options.error(message, response.status, code);
		}
		return await response.json() as T;
	}
	private context(id: string) { return encryptedOperationContext(this.options.authority.vaultId, this.options.authority.scopeId, id); }
	private async source(file: WireFile): Promise<Source> {
		let source = this.sources.get(file.path);
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
		this.sources.set(file.path, source);
		trimContentCache(this.sources, 100);
		return source;
	}

	/** Posts cards for notes the server lists as changed since their card, then lists. One
	 * fill runs at a time; a later caller waits for it. */
	fill(): Promise<void> {
		this.filling ??= this.fillStale().finally(() => { this.filling = undefined; });
		return this.filling;
	}
	private async fillStale(): Promise<void> {
		const unreadable = new Map<string, { message: string; id?: string }>();
		let after: string | null = '', filled = 0;
		while (after !== null && filled < MAX_FILLED_PER_REFRESH) {
			const page: { files: StaleFile[]; cursor: string | null } = await this.json(`/reading/cards/stale?${new URLSearchParams({ after })}`);
			after = page.cursor;
			const opened = await mapBounded(page.files, SOURCE_CONCURRENCY, async file => {
				try { return { file, card: await this.cardFor(file) }; }
				catch (error) { return { file, error: error instanceof Error ? error.message : 'Article could not be opened.' }; }
			});
			const cards: unknown[] = [];
			for (const result of opened) {
				if ('error' in result) { unreadable.set(result.file.path, { message: result.error! }); continue; }
				cards.push(result.card);
			}
			for (let start = 0; start < cards.length;) {
				let bytes = 0, end = start;
				while (end < cards.length && (end === start || bytes + JSON.stringify(cards[end]).length < MAX_CARD_POST_BYTES)) bytes += JSON.stringify(cards[end++]).length;
				// A card for a revision that changed meanwhile is skipped; the next fill posts it.
				await this.json('/reading/cards', JSON.stringify({ cards: cards.slice(start, end) }));
				start = end;
			}
			filled += page.files.length;
		}
		this.unreadable = unreadable;
	}
	/** The card a device posts for a changed note, after the sealed-note rule. */
	private async cardFor(file: StaleFile) {
		const source = await this.source(file);
		if (source.sealed) {
			// The server may only create sealed notes: never replace a note listed at this
			// path, nor take the name of a note stored at another server path.
			const held = file.card ? await openReadingCard(file.card, file.path, this.cardKeys).catch(() => undefined) : undefined;
			const own = { wire: file.path, path: source.item.path, hash: source.hash };
			const known = held ? [{ wire: file.path, path: held.item.path, hash: held.hash }] : [];
			const named = await this.options.paths.wire(source.item.path);
			if (!held && named !== file.path && (await this.existing([named])).has(named)) known.push({ wire: named, path: source.item.path, hash: '' });
			if (sealedNoteRefusal(own, known)) throw new Error(SEALED_ISSUE);
		}
		const item = source.item;
		return { path: file.path, revision: file.revision, card: await sealReadingCard(item, file.path, source.hash, this.cardKeys),
			terms: await hashedReadingTerms(this.options.searchKey, item), ...readingCardFields(item) };
	}
	private async existing(wires: string[]): Promise<Set<string>> {
		const params = new URLSearchParams(); for (const wire of wires) params.append('path', wire);
		return new Set((await this.json<{ paths: string[] }>(`/reading/cards/exists?${params}`)).paths);
	}

	/** One page of the library: the server matches hashed terms, and each card is opened and
	 * rechecked here, so a page can hold fewer items than the server listed. */
	private async items(params: URLSearchParams): Promise<ItemsPage> {
		const q = params.get('q') ?? '', tag = params.get('tag') ?? '', url = params.get('url') ?? '', cursor = params.get('cursor') ?? '', id = params.get('id');
		if (!cursor) await this.fill();
		const query = new URLSearchParams({ section: params.get('section') ?? 'inbox', ...cursor ? { cursor } : {}, ...id ? { id } : {} });
		for (const term of await hashedQueryTerms(this.options.searchKey, { q, tag, url })) query.append('term', term);
		const page: { cards: Array<WireFile & { card: string; stale: boolean; fields: Partial<ReadingCardFields> }>; cursor: string | null } = await this.json(`/reading/items?${query}`);
		const items: ReadingItem[] = [], issues: ItemsPage['issues'] = [];
		const ids = new Map<string, number>();
		for (const listed of page.cards) {
			const { card, stale, fields, ...file } = listed;
			let item: ReadingItem;
			try {
				item = (await openReadingCard(card, file.path, this.cardKeys)).item;
				// The server sorts by the listed fields; one that disagrees with its card is not trusted.
				if (!sameReadingCardFields(item, fields ?? {})) throw new Error();
			} catch { issues.push({ path: file.path, message: 'This Reading card is unreadable. Open the note in Obsidian.' }); continue; }
			if (q && !titleMatches(item.title, q)) continue;
			if (tag && !item.tags.some(value => normalizedTag(value) === normalizedTag(tag))) continue;
			if (url) { try { if (!item.source_url || readingUrlIdentity(item.source_url) !== readingUrlIdentity(url)) continue; } catch { continue; } }
			if (id && item.crate_reading_id !== id) continue;
			ids.set(item.crate_reading_id, (ids.get(item.crate_reading_id) ?? 0) + 1);
			this.listed.set(item.crate_reading_id, { file, item, stale });
			items.push(item);
		}
		for (const [path, problem] of this.unreadable) if (!cursor) issues.push({ path, message: problem.message });
		const unique = items.filter(item => {
			if (ids.get(item.crate_reading_id)! === 1) return true;
			issues.push({ path: item.path, message: READING_DUPLICATE_ID_ISSUE });
			return false;
		});
		return { items: unique, issues, cursor: page.cursor };
	}
	/** The listed note with this Reading ID, read from the server when this client has not listed it. */
	private async find(id: string): Promise<Listed | undefined> {
		await this.items(new URLSearchParams({ section: 'all', id }));
		return this.listed.get(id);
	}

	async request(path: string, rawBody?: string): Promise<unknown> {
		const url = new URL(path, 'https://crate.invalid'), action = url.pathname.slice('/reading/'.length);
		if (action === 'items') return this.items(url.searchParams);
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
			for (const [itemId, listed] of this.listed) if (committed.files.concat(committed.remove ?? []).some(file => file.path === listed.file.path)) this.listed.delete(itemId);
			// The commit left the note's card stale; post its new card now.
			await this.fill().catch(() => { /* The next refresh posts it. */ });
			return receipt.response;
		}
	}
	/** One article and its revision ETag, derived from its file. With `savedEtag`, resolves
	 * to null without downloading while that revision is current. */
	async item(id: string, savedEtag?: string): Promise<{ article: { item: ReadingItem; markdown: string }; etag: string } | null> {
		const listed = await this.find(id);
		if (!listed) throw this.options.error('Article is unavailable or has an identity conflict.', 409, 'reading_conflict');
		const { file } = listed;
		const etag = `"e2ee-file-${this.options.generation}-${(await sha256Hex(`${file.path}\n${file.revision}\n${file.hash}`)).slice(0, 32)}"`;
		if (etag === savedEtag) return null;
		const source = await this.source(file);
		if (source.item.crate_reading_id !== id) throw this.options.error('Article is unavailable or has an identity conflict.', 409, 'reading_conflict');
		return { article: { item: source.item, markdown: readReadingFrontmatter(source.content)!.body }, etag };
	}
	/** Build and persist exact ciphertext for one operation against the current
	 * notes, or answer from a receipt the operation already committed. */
	private async prepare(action: string, body: Record<string, unknown>, id: string, rawBody: string, requestHash: string): Promise<{ attempt: Attempt } | { response: unknown }> {
		await this.fill();
		const plan = action === 'capture' ? await this.planCapture(body, id, rawBody) : await this.planEdit(action, body);
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
		// The server knows a name only by its tag, so a candidate is taken when its tag is stored.
		const occupied = async (candidate: string) => {
			const tag = await this.options.paths.wire(candidate);
			return tag !== previous?.path && (await this.existing([tag])).has(tag);
		};
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
		// Any unreadable note may already save this link; a new note would duplicate it.
		if (this.unreadable.size) throw this.unavailable();
		const link = readingUrl(body.url);
		const { items, issues } = await this.items(new URLSearchParams({ section: 'all', url: link }));
		if (items.length > 1) throw this.options.error('Several notes already save this link.', 409);
		if (issues.some(issue => issue.message === READING_DUPLICATE_ID_ISSUE)) throw this.unavailable(READING_DUPLICATE_ID_ISSUE);
		if (items[0]) return { response: { saved: true, alreadySaved: true, id: items[0].crate_reading_id } };
		// Stable even if preparation is interrupted before ciphertext persistence.
		const itemId = typeof body.captureId === 'string' ? body.captureId : await readingImportId(id, rawBody);
		let content = createReadingNote({ id: itemId, url: link, title: typeof body.title === 'string' ? body.title : undefined, savedAt: new Date().toISOString() });
		if (body.fetchArticle === false) content = patchReadingFrontmatter(content, { extraction_status: 'unavailable' });
		return { kind: 'write', itemId, content, path: '', wire: '' };
	}
	/** The note an update, retry or delete targets, with its new content or its removal. */
	private async planEdit(action: string, body: Record<string, unknown>): Promise<PreparedPlan> {
		if (typeof body.id !== 'string') throw this.options.error('This article moved or was deleted.', 409, 'reading_conflict');
		const listed = await this.find(body.id);
		// An unreadable note may be the target when the target is not listed.
		if (!listed && this.unreadable.size) throw this.unavailable();
		if (!listed) throw this.options.error('This article moved or was deleted.', 409, 'reading_conflict');
		const source = await this.source(listed.file);
		// The card may describe an earlier revision; the edit applies to the note as it is now.
		const item = source.item;
		if (item.crate_reading_id !== body.id) throw this.unavailable(READING_DUPLICATE_ID_ISSUE);
		const command = action === 'delete' || action === 'retry' ? action : 'update';
		const plan = await planReadingFileCommand(item, source.content, { action: command, before: body.before, changes: body.changes, markdownHash: body.markdownHash });
		if (plan.kind === 'issue') {
			const refusal = readingFileCommandRefusal(plan, command);
			throw this.options.error(refusal.message, refusal.status, refusal.code);
		}
		if (plan.kind === 'remove') return { kind: 'remove', itemId: item.crate_reading_id, file: source.file };
		return { kind: 'write', itemId: item.crate_reading_id, content: plan.content, path: item.path, wire: listed.file.path, previous: source.file, before: item };
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
