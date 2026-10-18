import { applyLocalArticle } from './core/article';
import { isEmptyReadingCapture, readingUpdateIssue } from './core/mutation-policy';
import type { CapturedArticle } from './extraction/types';
import { openFile, sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { decryptJson, encryptJson } from '@/encryption/envelope';
import { createReadingNote, parseReadingNote, updateReadingNote, readingImportId } from './core/notes';
import { readReadingFrontmatter, patchReadingFrontmatter } from './core/frontmatter';
import { MAX_READING_BYTES, readingUrl, readingUrlIdentity, type ReadingItem } from './core/model';
import { readingCapturePath } from './core/filename';
import { portablePathKey } from '@/protocol/portable-path';
import { reminderRequestHash } from '@/encryption/reminder-receipt';
import { createEncryptedInventoryProgress, parseEncryptedInventoryPage, type EncryptedInventoryFile as WireFile, type EncryptedInventoryPage } from '@/encryption/file-inventory';

const MAX_READING_FILES = 100_000;
const MAX_READING_METADATA_BYTES = 64 * 1024 * 1024;
// Changed notes download in parallel, a few at a time, in page order.
const SOURCE_CONCURRENCY = 6;
/** `revision` fingerprints the Reading files and issues, so edits elsewhere in the vault keep it. */
interface EncryptedReadingInventory { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: null; revision: string }

interface Source { file: WireFile; content: string; item: ReadingItem }
/** Authenticated metadata for one encrypted note, reusable while its file is unchanged. */
export interface EncryptedReadingIndexEntry { file: WireFile; item: ReadingItem }
interface Attempt { requestHash: string; body: string; generation?: number }
interface EncryptedReadingOptions {
  folderPath: string; generation: number; authority: FileEncryptionAuthority;
  captureArticle?(url: string): Promise<CapturedArticle>;
  request(path: string, body?: string): Promise<Response>;
  readAttempt(id: string): Promise<unknown>;
  writeAttempt(id: string, attempt: Attempt): Promise<void>;
  /** Optional local copy of the index, so a reload only downloads changed notes. */
  loadIndex?(): Promise<EncryptedReadingIndexEntry[] | undefined>;
  saveIndex?(entries: EncryptedReadingIndexEntry[]): Promise<void>;
  error(message: string, status: number, code?: string): Error;
}
function sameFile(a: WireFile, b: WireFile): boolean {
  return a.revision === b.revision && a.hash === b.hash && a.size === b.size;
}
async function mapBounded<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => { while (next < values.length) { const index = next++; results[index] = await map(values[index]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}
async function hash(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Plaintext only exists in the trusted client. Every dispatched mutation is
 * persisted as exact ciphertext first, including its authenticated receipt. */
export class EncryptedReadingApi {
  private sources = new Map<string, Source>();
  private files = new Map<string, WireFile>();
  private indexed = new Map<string, EncryptedReadingIndexEntry>();
  private indexLoaded = false;
  // The last complete inventory and the vault sequence it was confirmed at. An
  // unchanged first page answers from it, so polling is one request.
  private confirmed?: { sequence: number; result: EncryptedReadingInventory };
  constructor(private options: EncryptedReadingOptions) {}
  private async json<T>(path: string, body?: string): Promise<T> {
    const response = await this.options.request(path, body);
    const value = await response.json() as T & { error?: string; code?: string };
    if (!response.ok) throw this.options.error(value.error ?? 'Reading request failed.', response.status, value.code);
    return value;
  }
  private context(id: string) { return { vaultId: this.options.authority.vaultId, scopeId: this.options.authority.scopeId, objectId: id, purpose: 'reminder' as const }; }
  private async source(file: WireFile, sources = this.sources): Promise<Source> {
    const folder = encodeURIComponent(this.options.folderPath);
    let source = sources.get(file.path);
    if (!source || !sameFile(source.file, file)) {
      const response = await this.options.request(`/reading/encrypted-file?folderPath=${folder}&path=${encodeURIComponent(file.path)}&revision=${encodeURIComponent(file.revision)}`);
      if (!response.ok) throw new Error('Article changed or is unavailable. Refresh to retry.');
      if (file.size > 4 * 1024 * 1024) throw new Error('This Reading note is too large.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== file.size || await hash(bytes) !== file.hash) throw new Error('Encrypted article failed integrity verification.');
      const opened = await openFile(bytes, file.path, this.options.authority);
      if (opened.content.byteLength > MAX_READING_BYTES) throw new Error('Reading notes must be smaller than 1 MB.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(opened.content);
      const metadata = parseReadingNote(content);
      if (!metadata) throw new Error('Open Obsidian to import this note into Reading.');
      source = { file, content, item: { ...metadata, path: file.path } };
    }

    sources.set(file.path, source);
    let bytes = [...sources.values()].reduce((sum, value) => sum + value.content.length * 2, 0);
    while (bytes > 16 * 1024 * 1024 || sources.size > 100) {
      const first = sources.keys().next().value!;
      bytes -= sources.get(first)!.content.length * 2; sources.delete(first);
    }
    return source;
  }
  private async inventory(): Promise<EncryptedReadingInventory> {
    const folder = encodeURIComponent(this.options.folderPath);
    let first: EncryptedInventoryPage | undefined = parseEncryptedInventoryPage(await this.json(`/reading/encrypted-files?folderPath=${folder}`), this.options.folderPath, this.options.generation);
    if (this.confirmed?.sequence === first.sequence) return this.confirmed.result;
    if (!this.indexLoaded) {
      this.indexLoaded = true;
      try { if (!this.indexed.size) for (const entry of await this.options.loadIndex?.() ?? []) this.indexed.set(entry.file.path, entry); }
      catch { /* A missing or unreadable local index only costs downloads. */ }
    }
    let cursor: string | null = null, sequence: number | undefined;
    const candidates: ReadingItem[] = [];
    const next = new Map<string, WireFile>(), issues: Array<{ path: string; message: string }> = [];
    const nextIndex = new Map<string, EncryptedReadingIndexEntry>();
    let downloaded = false;
    const nextSources = new Map(this.sources);
    const acceptPage = createEncryptedInventoryProgress({ maxFiles: MAX_READING_FILES, maxPages: 1000 });
    let metadataBytes = 0;
    do {
      const page: EncryptedInventoryPage = first ?? parseEncryptedInventoryPage(await this.json(`/reading/encrypted-files?folderPath=${folder}${cursor ? '&after=' + encodeURIComponent(cursor) : ''}`), this.options.folderPath, this.options.generation);
      first = undefined;
      sequence ??= page.sequence;
      if (page.sequence !== sequence) throw new Error('Reading changed while loading. Refresh again.');
      acceptPage(page);
      const loaded = await mapBounded(page.files, SOURCE_CONCURRENCY, async file => {
        const cached = this.indexed.get(file.path);
        if (cached && sameFile(cached.file, file)) return { item: cached.item };
        try { const { item } = await this.source(file, nextSources); downloaded = true; return { item }; }
        catch (error) { return { error }; }
      });
      for (const [index, file] of page.files.entries()) {
        try {
          next.set(file.path, file);
          const result = loaded[index]!;
          if ('error' in result) throw result.error;
          const item = result.item;
          metadataBytes += new TextEncoder().encode(JSON.stringify(item)).length;
          if (metadataBytes > MAX_READING_METADATA_BYTES) throw new Error('Reading metadata exceeds this device’s library limit.');
          candidates.push(item);
          nextIndex.set(file.path, { file, item });
        } catch (error) { issues.push({ path: file.path, message: error instanceof Error ? error.message : 'Article could not be opened.' }); }
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (metadataBytes > MAX_READING_METADATA_BYTES) throw new Error('Reading metadata exceeds this device’s library limit.');
    const confirmed = parseEncryptedInventoryPage(await this.json(`/reading/encrypted-files?folderPath=${folder}`), this.options.folderPath, this.options.generation);
    if (confirmed.sequence !== sequence) throw new Error('Reading changed while loading. Refresh again.');
    const removed = [...this.indexed.keys()].some(path => !nextIndex.has(path));
    this.files = next;
    this.indexed = nextIndex;
    for (const path of nextSources.keys()) if (!next.has(path)) nextSources.delete(path);
    this.sources = nextSources;
    const counts = new Map<string, number>();
    for (const item of candidates) counts.set(item.crate_reading_id, (counts.get(item.crate_reading_id) ?? 0) + 1);
    const items = candidates.flatMap(item => {
      if (counts.get(item.crate_reading_id) === 1) return [item];
      issues.push({ path: item.path, message: 'Several notes have this Reading ID. Resolve the duplicates in Obsidian.' }); return [];
    });
    // Unrelated vault edits advance the sequence; an unchanged fingerprint lets
    // callers keep their saved library instead of rewriting and redrawing it.
    const fingerprint = JSON.stringify([[...next.values()].map(file => [file.path, file.revision, file.hash, file.size]), issues.map(issue => [issue.path, issue.message])]);
    const revision = `"e2ee-reading-${this.options.generation}-${(await hash(fingerprint)).slice(0, 32)}"`;
    const result: EncryptedReadingInventory = this.confirmed?.result.revision === revision ? this.confirmed.result : { items, issues, cursor: null, revision };
    this.confirmed = { sequence: sequence, result };
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
      return { item, markdown: readReadingFrontmatter((await this.source(this.files.get(item.path)!)).content)!.body };
    }
    if (!rawBody || !['capture', 'update', 'retry'].includes(action)) throw new Error('Unsupported encrypted Reading request.');
    const body = JSON.parse(rawBody) as Record<string, unknown>, id = body.operationId;
    if (typeof id !== 'string') throw new Error('A saved Reading operation ID is required.');
    const requestHash = await hash(JSON.stringify({ action, body }));
    const saved = await this.options.readAttempt(id) as Attempt | undefined;
    if (saved && (saved.requestHash !== requestHash || typeof saved.body !== 'string')) throw new Error('This encrypted Reading attempt belongs to a different change.');
    let attempt = saved;
    if (attempt && (attempt.generation !== undefined ? attempt.generation !== this.options.generation
      : (JSON.parse(attempt.body) as { folderPath: string }).folderPath !== this.options.folderPath)) {
      const legacy = await this.json<{ envelope: string | null }>(`/reading/encrypted-receipt?operationId=${encodeURIComponent(id)}&wire=1`);
      if (legacy.envelope) {
        const receipt = await decryptJson(legacy.envelope, this.options.authority.key, this.context(id)) as { requestHash: string; response: { encrypted?: string } };
        if (receipt.requestHash !== await reminderRequestHash('encrypted-files', JSON.parse(attempt.body) as Record<string, unknown>) || typeof receipt.response?.encrypted !== 'string') throw new Error('The saved Reading receipt does not match its original attempt.');
        const result = await decryptJson(receipt.response.encrypted, this.options.authority.key, this.context(id)) as { requestHash: string; response: unknown };
        if (result.requestHash !== requestHash) throw new Error('The saved Reading receipt belongs to another change.');
        return result.response;
      }
      // Conversion fenced all older writes; no receipt means this exact attempt
      // did not commit. Rebuild against current files, preserving the operation ID.
      attempt = undefined;
    }
    if (!attempt) {
      const legacy = await this.json<{ envelope: string | null }>(`/reading/encrypted-receipt?operationId=${encodeURIComponent(id)}`);
      if (legacy.envelope) {
        const result = await decryptJson(legacy.envelope, this.options.authority.key, this.context(id)) as { requestHash: string; response: unknown };
        if (result.requestHash !== requestHash) throw this.options.error('The saved operation belongs to a different change.', 409);
        return result.response;
      }
      const list = await this.inventory();
      if (list.issues.length) throw this.options.error('Refresh or resolve unreadable Reading notes before saving changes.', 409, 'reading_conflict');
      let path: string, content: string, previous: WireFile | undefined, itemId: string;
      if (action === 'capture') {
        const link = readingUrl(body.url), matches = list.items.filter(item => item.source_url && readingUrlIdentity(item.source_url) === readingUrlIdentity(link));
        if (matches.length > 1) throw this.options.error('Several notes already save this link.', 409);
        if (matches[0]) return { saved: true, alreadySaved: true, id: matches[0].crate_reading_id };
        // Stable even if preparation is interrupted before ciphertext persistence.
        itemId = typeof body.captureId === 'string' ? body.captureId : await readingImportId(id, rawBody);
        content = createReadingNote({ id: itemId, url: link, title: typeof body.title === 'string' ? body.title : undefined, savedAt: new Date().toISOString() });
        if (body.fetchArticle === false) content = patchReadingFrontmatter(content, { extraction_status: 'unavailable' });
        path = await readingCapturePath(this.options.folderPath, 'Article', itemId, candidate => [...this.files.keys()].some(p => portablePathKey(p) === portablePathKey(candidate)));
      } else {
        const item = list.items.find(item => item.crate_reading_id === body.id);
        if (!item) throw this.options.error('This article moved or was deleted.', 409, 'reading_conflict');
        const source = await this.source(this.files.get(item.path)!); path = item.path; previous = source.file; itemId = item.crate_reading_id;
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
        } catch { /* The pending encrypted bookmark is completed by a trusted Obsidian device. */ }
      }
      const sealed = await sealFile({ path, content: new TextEncoder().encode(content), contentType: 'text/markdown', publicData: null }, this.options.authority);
      const response = { saved: true, id: itemId };
      const acknowledgment = await encryptJson({ requestHash, response }, this.options.authority.key, this.context(id));
      attempt = { requestHash, generation: this.options.generation, body: JSON.stringify({ folderPath: this.options.folderPath, operationId: id, files: [{ path, content: new TextDecoder().decode(sealed.bytes), expectedHash: previous?.hash ?? null, ...(previous ? { expectedRevision: previous.revision } : {}) }], acknowledgment }) };
      await this.options.writeAttempt(id, attempt);
    }
    const result = await this.json<{ encrypted: string }>('/reading/encrypted-commit', attempt.body);
    const receipt = await decryptJson(result.encrypted, this.options.authority.key, this.context(id)) as { requestHash: string; response: unknown };
    if (receipt.requestHash !== requestHash) throw new Error('The encrypted Reading acknowledgment does not match this change.');
    this.sources.clear();
    return receipt.response;
  }
}
