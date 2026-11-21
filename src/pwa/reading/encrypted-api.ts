import { applyLocalArticle } from '../../reading/core/article';
import { downloadArticleImages, linkedVaultImages, linkSavedImages, readingImageFolder, type ReadingImageFile } from '../../reading/core/article-images';
import type { ServerCapturedArticle } from './capture-article';
import { planReadingFileCommand, readingFileCommandRefusal } from '../../reading/core/reading-file-command';
import { openFile, sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { decryptJson, encryptJson } from '@/encryption/envelope';
import { createReadingNote, parseReadingNote, readingImportId } from '../../reading/core/notes';
import { readReadingFrontmatter, patchReadingFrontmatter } from '../../reading/core/frontmatter';
import { MAX_READING_BYTES, readingUrl, readingUrlIdentity, type ReadingItem } from '../../reading/core/model';
import { readingCapturePath, retitledCapturePath } from '../../reading/core/filename';
import { READING_DUPLICATE_ID_ISSUE } from '../../reading/core/inventory';
import { matchesReadingQuery } from '../../reading/core/search-terms';
import { openReadingCard, openReadingTagName, sameReadingCardFields, type ReadingCardFields, type ReadingTagName } from '../../reading/core/reading-card';
import { readingUploadCard } from '../../reading/core/reading-card-upload';
import { hashedQueryTerms } from '@/encryption/reading-search';
import { type EncryptedInventoryFile as WireFile, MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES, sameInventoryFile } from '@/encryption/file-inventory';
import { sha256Hex } from '@/platform/sha256';
import { trimContentCache } from '@/pwa/storage/content-cache';
import { responseError } from '@/pwa/connection/response-error';
import type { PathTags } from '@/encryption/path-tags';
import { commitEncryptedAttempt, encryptedFilePath, encryptedOperationContext, openEncryptedNote } from '../encryption/encrypted-folder-client';

/** `hash` is the authenticated plaintext hash. */
interface Source { file: WireFile; content: string; item: ReadingItem; hash: string }
/** A listed note: its current server file and the item its card lists. */
interface Listed { file: WireFile; item: ReadingItem; stale: boolean }
/** `rejected` marks an attempt the Worker refused with `version_conflict`; it is rebuilt, never resent. */
interface Attempt { requestHash: string; body: string; generation: number; rejected?: true }
/** What `prepare` commits: the answer when nothing needs writing, a note removal, or a
 * note write. A capture has no path until its note is named. */
type PreparedPlan =
	| { response: unknown }
	| { kind: 'remove'; itemId: string; file: WireFile; images: string[] }
	| { kind: 'write'; itemId: string; content: string; path: string; wire: string; previous?: WireFile; before?: ReadingItem };
interface EncryptedReadingOptions {
	/** The plaintext Reading folder; requests name `wireFolder`, its server form. */
	folderPath: string; wireFolder: string; paths: PathTags; generation: number; authority: FileEncryptionAuthority;
	/** Hashes search terms (`src/encryption/reading-search.ts`). */
	searchKey: CryptoKey;
	captureArticle?(url: string): Promise<ServerCapturedArticle>;
	request(path: string, body?: string, headers?: Record<string, string>): Promise<Response>;
	readAttempt(id: string): Promise<unknown>;
	writeAttempt(id: string, attempt: Attempt): Promise<void>;
	error(message: string, status: number, code?: string): Error;
}
/** A note download that failed in transit. Unlike a rejected note, it is retried. */
class NoteUnavailableError extends Error {}

/** Reading routes this client answers; an encrypted session never sends them in plaintext. */
export const ENCRYPTED_READING_ACTIONS: readonly string[] = ['items', 'item', 'tags', 'capture', 'update', 'retry', 'delete'];

interface ItemsPage { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: string | null }

/**
 * Plaintext only exists in the trusted client. The server lists encrypted cards a page at a
 * time and this client opens them. Every note it writes carries its card as public data, and
 * every mutation is persisted as exact ciphertext first, including its authenticated receipt.
 */
export class EncryptedReadingApi {
	private sources = new Map<string, Source>();
	// Notes this client listed, by Reading ID, so an open or an edit finds its file.
	private listed = new Map<string, Listed>();
	constructor(private options: EncryptedReadingOptions) {}
	private get cardKeys() { return { vaultId: this.options.authority.vaultId, key: this.options.authority.key, keyGeneration: this.options.generation, searchKey: this.options.searchKey }; }
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
			const opened = await openEncryptedNote(response, file, { authority: this.options.authority, integrityError: 'Encrypted article failed integrity verification.',
				paths: this.options.paths });
			if (opened.content.byteLength > MAX_READING_BYTES) throw new Error('Reading notes must be smaller than 1 MB.');
			const content = new TextDecoder('utf-8', { fatal: true }).decode(opened.content);
			const metadata = parseReadingNote(content);
			if (!metadata) throw new Error('Open Obsidian to import this note into Reading.');
			source = { file, content, item: { ...metadata, path: opened.metadata.path }, hash: opened.metadata.hash };
		}
		this.sources.set(file.path, source);
		trimContentCache(this.sources, 100);
		return source;
	}

	/** An image file in the Reading folder, decrypted. Its metadata must name `path`. */
	async image(path: string): Promise<Uint8Array<ArrayBuffer>> {
		const wire = await this.options.paths.wire(path);
		const response = await this.options.request(`/reading/encrypted-file?${new URLSearchParams({ folderPath: this.options.wireFolder, path: wire })}`);
		if (!response.ok) {
			const { message, code } = await responseError(response, 'Image is unavailable.');
			throw this.options.error(message, response.status, code);
		}
		return (await openFile(new Uint8Array(await response.arrayBuffer()), path, this.options.authority)).content;
	}

	private async existing(wires: string[]): Promise<Set<string>> {
		const params = new URLSearchParams(); for (const wire of wires) params.append('path', wire);
		return new Set((await this.json<{ paths: string[] }>(`/reading/taken?${params}`)).paths);
	}

	/** One page of the library: the server matches hashed terms, and each card is opened and
	 * rechecked here, so a page can hold fewer items than the server listed. */
	private async items(params: URLSearchParams): Promise<ItemsPage> {
		const q = params.get('q') ?? '', tag = params.get('tag') ?? '', url = params.get('url') ?? '', cursor = params.get('cursor') ?? '', id = params.get('id');
		const highlights = params.get('section') === 'highlights';
		const query = new URLSearchParams({ section: params.get('section') ?? 'inbox', ...cursor ? { cursor } : {}, ...id ? { id } : {} });
		for (const term of await hashedQueryTerms(this.options.searchKey, { q, tag, url })) query.append('term', term);
		type ListedCard = WireFile & { card: string; stale: boolean; fields: Partial<ReadingCardFields> };
		const page: { cards: ListedCard[]; cursor: string | null } = await this.json(`/reading/items?${query}`);
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
			// The Highlights tab matches highlight text and notes as well as the title.
			if (!matchesReadingQuery(item, { query: q, tag, highlights })) continue;
			if (url) { try { if (!item.source_url || readingUrlIdentity(item.source_url) !== readingUrlIdentity(url)) continue; } catch { continue; } }
			if (id && item.crate_reading_id !== id) continue;
			ids.set(item.crate_reading_id, (ids.get(item.crate_reading_id) ?? 0) + 1);
			this.listed.set(item.crate_reading_id, { file, item, stale });
			items.push(item);
		}
		const unique = items.filter(item => {
			if (ids.get(item.crate_reading_id)! === 1) return true;
			issues.push({ path: item.path, message: READING_DUPLICATE_ID_ISSUE });
			return false;
		});
		return { items: unique, issues, cursor: page.cursor };
	}
	/** Every tag name the server lists, opened here. A name sealed for another term is dropped.
	 * With a section, each name keeps its note count, in the server's most used order. */
	private async tags(section: string | null): Promise<{ tags: string[]; counts?: number[] }> {
		const { sealed } = await this.json<{ sealed: Array<ReadingTagName & { count?: number }> }>(section ? `/reading/tags?section=${encodeURIComponent(section)}` : '/reading/tags');
		const names = await Promise.all(sealed.map(tag => openReadingTagName(tag, this.cardKeys)));
		const counts = new Map<string, number | undefined>();
		names.forEach((name, index) => { if (name && !counts.has(name)) counts.set(name, sealed[index]!.count); });
		const opened = [...counts];
		if (!section || !opened.every(([, count]) => typeof count === 'number')) return { tags: opened.map(([name]) => name).sort((a, b) => a.localeCompare(b)) };
		return { tags: opened.map(([name]) => name), counts: opened.map(([, count]) => count!) };
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
		if (action === 'tags') return await this.tags(url.searchParams.get('section'));
		if (!rawBody || !ENCRYPTED_READING_ACTIONS.includes(action)) throw new Error('Unsupported encrypted Reading request.');
		const body = JSON.parse(rawBody) as Record<string, unknown>, id = body.operationId;
		if (typeof id !== 'string') throw new Error('A saved Reading operation ID is required.');
		const requestHash = await sha256Hex(JSON.stringify({ action, body }));
		const saved = await this.options.readAttempt(id) as Attempt | undefined;
		// Unlike Reminders, which lets a changed request replace a rejected attempt, an operation ID names one change for good.
		if (saved && (saved.requestHash !== requestHash || typeof saved.body !== 'string')) throw new Error('This encrypted Reading attempt belongs to a different change.');
		let attempt = saved;
		// Other keys can no longer publish, so this attempt never committed. Rebuild it
		// against current files, preserving the operation ID. Unlike Reminders, it is only
		// dropped here: writing an attempt replaces whatever is stored.
		if (attempt && attempt.generation !== this.options.generation) attempt = undefined;
		return commitEncryptedAttempt<Attempt, unknown>((path, body) => this.options.request(path, body), '/reading', attempt, {
			build: () => this.prepare(action, body, id, rawBody, requestHash),
			reject: rejected => this.options.writeAttempt(id, rejected),
			// Unlike Reminders, this client answers with values and raises refusals as feature
			// errors, and a second conflict needs review. It keeps no acknowledgment: the Worker
			// replays the receipt, which must name this change.
			settle: async (outcome, sent) => {
				if (outcome.kind === 'conflict') throw this.options.error(outcome.answer.error ?? 'A note changed. Refresh before retrying.', outcome.response.status, outcome.answer.code);
				if (outcome.kind === 'failed') {
					const { message, code } = outcome.answer
						? { message: outcome.answer.error ?? 'Reading request failed.', code: outcome.answer.code }
						: await responseError(outcome.response, 'Reading request failed.');
					throw this.options.error(message, outcome.response.status, code);
				}
				const receipt = await decryptJson(outcome.encrypted, this.options.authority.key, this.context(id)) as { requestHash: string; response: unknown };
				if (receipt.requestHash !== requestHash) throw new Error('The encrypted Reading acknowledgment does not match this change.');
				// Other decrypted notes stay valid; `sameInventoryFile` rejects any that changed elsewhere.
				const committed = JSON.parse(sent.body) as { files: Array<{ path: string }>; remove?: Array<{ path: string }> };
				for (const file of [...committed.files, ...committed.remove ?? []]) this.sources.delete(file.path);
				for (const [itemId, listed] of this.listed) if (committed.files.concat(committed.remove ?? []).some(file => file.path === listed.file.path)) this.listed.delete(itemId);
				return receipt.response;
			},
		});
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
		const plan = action === 'capture' ? await this.planCapture(body, id, rawBody) : await this.planEdit(action, body);
		if ('response' in plan) return plan;
		const { itemId } = plan;
		if (plan.kind === 'remove') return { attempt: await this.persistAttempt(id, requestHash, { deleted: true, id: itemId }, [], [plan.file], [], plan.images) };
		let { content, path, wire, previous } = plan;
		let images: ReadingImageFile[] = [];
		if ((action === 'capture' && body.fetchArticle !== false || action === 'retry') && this.options.captureArticle) {
			const item = parseReadingNote(content)!;
			try {
				const { images: downloaded, ...article } = await this.options.captureArticle(item.source_url);
				// Images the server downloaded are saved beside a new note; the server stored none of them.
				if (downloaded?.length && action === 'capture') {
					images = await downloadArticleImages(article.markdown, { folder: this.options.folderPath, id: itemId, signal: new AbortController().signal,
						fetchImage: async url => downloaded.find(image => image.url === url)?.bytes ?? null });
					article.markdown = linkSavedImages(article.markdown, this.options.folderPath, images);
				}
				content = applyLocalArticle(patchReadingFrontmatter(content, { extraction_status: 'unavailable' }), { ...item, path }, article);
			} catch { content = patchReadingFrontmatter(content, { extraction_status: 'unavailable' }); images = []; }
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
		// The note's card is its public data, so the server lists the new revision in the same commit.
		const bytes = new TextEncoder().encode(content);
		const publicData = await readingUploadCard(this.options.folderPath, path, wire, bytes, this.cardKeys);
		const sealed = await sealFile({ path, content: bytes, publicData }, this.options.authority);
		const file = { path: wire, content: new TextDecoder().decode(sealed.bytes), expectedHash: previous?.hash ?? null, ...(previous ? { expectedRevision: previous.revision } : {}) };
		// Images carry no public data: the server learns only that the note has some files beside it.
		const attachments = await Promise.all(images.map(async image => ({ path: await this.options.paths.wire(image.path),
			content: new TextDecoder().decode((await sealFile({ path: image.path, content: image.bytes.slice(), publicData: null }, this.options.authority)).bytes) })));
		return { attempt: await this.persistAttempt(id, requestHash, { saved: true, id: itemId }, [file], removed ? [removed] : [], attachments) };
	}
	/** A new note for a captured link, or the answer when a note already saves it. */
	private async planCapture(body: Record<string, unknown>, id: string, rawBody: string): Promise<PreparedPlan> {
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
		if (plan.kind === 'remove') {
			// The images Crate saved for this article go with it. The server knows them only by
			// their tags, so the note's links name them.
			const folder = `${readingImageFolder(this.options.folderPath, item.crate_reading_id)}/`;
			const saved = linkedVaultImages(readReadingFrontmatter(source.content)!.body, item.path).filter(path => path.startsWith(folder) && !path.slice(folder.length).includes('/'));
			const images = await Promise.all(saved.slice(0, 30).map(path => this.options.paths.wire(path)));
			return { kind: 'remove', itemId: item.crate_reading_id, file: source.file, images };
		}
		return { kind: 'write', itemId: item.crate_reading_id, content: plan.content, path: item.path, wire: listed.file.path, previous: source.file, before: item };
	}
	/** An unreadable note may be a failed download, so a change it blocks stays queued
	 * and retries; a rejection here would strand it for review once the note recovers. */
	private unavailable(message = 'Refresh or resolve unreadable Reading notes before saving changes.'): Error {
		return this.options.error(message, 503, 'reading_unavailable');
	}
	/** Stores the exact commit body, with the encrypted receipt `response` answers with. */
	private async persistAttempt(id: string, requestHash: string, response: unknown, files: unknown[], remove: WireFile[], attachments: { path: string; content: string }[] = [], removeAttachments: string[] = []): Promise<Attempt> {
		const acknowledgment = await encryptJson({ requestHash, response }, this.options.authority.key, this.context(id));
		const attempt: Attempt = { requestHash, generation: this.options.generation, body: JSON.stringify({ folderPath: this.options.wireFolder, operationId: id, files,
			...(remove.length ? { remove: remove.map(file => ({ path: file.path, expectedHash: file.hash, expectedRevision: file.revision })) } : {}),
			...(attachments.length ? { attachments } : {}), ...(removeAttachments.length ? { removeAttachments } : {}), acknowledgment }) };
		await this.options.writeAttempt(id, attempt);
		return attempt;
	}
}
