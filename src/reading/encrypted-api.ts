import { applyLocalArticle, managedArticle } from './core/article';
import type { CapturedArticle } from './extraction/types';
import { openFile, sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { decryptJson, encryptJson } from '@/encryption/envelope';
import { createReadingNote, parseReadingNote, updateReadingNote, readingImportId } from './core/notes';
import { readReadingFrontmatter, patchReadingFrontmatter } from './core/frontmatter';
import { MAX_READING_BYTES, readingUrl, readingUrlIdentity, type ReadingChanges, type ReadingItem } from './core/model';
import { readingCapturePath } from './core/filename';
import { portablePathKey } from '@/protocol/portable-path';
import { reminderRequestHash } from '@/encryption/reminder-receipt';

interface WireFile { path: string; hash: string; size: number; revision: string }
interface Source { file: WireFile; content: string; item: ReadingItem }
interface Attempt { requestHash: string; body: string; generation?: number }
interface EncryptedReadingOptions {
  folderPath: string; generation: number; authority: FileEncryptionAuthority;
  captureArticle?(url: string): Promise<CapturedArticle>;
  request(path: string, body?: string): Promise<Response>;
  readAttempt(id: string): Promise<unknown>;
  writeAttempt(id: string, attempt: Attempt): Promise<void>;
  error(message: string, status: number, code?: string): Error;
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
  private indexed = new Map<string, { file: WireFile; item: ReadingItem }>();
  constructor(private options: EncryptedReadingOptions) {}
  private async json<T>(path: string, body?: string): Promise<T> {
    const response = await this.options.request(path, body);
    const value = await response.json() as T & { error?: string; code?: string };
    if (!response.ok) throw this.options.error(value.error ?? 'Reading request failed.', response.status, value.code);
    return value;
  }
  private context(id: string) { return { vaultId: this.options.authority.vaultId, scopeId: this.options.authority.scopeId, objectId: id, purpose: 'reminder' as const }; }
  private async source(file: WireFile): Promise<Source> {
    const folder = encodeURIComponent(this.options.folderPath);
    let source = this.sources.get(file.path);
    if (!source || source.file.revision !== file.revision || source.file.hash !== file.hash) {
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

    this.sources.set(file.path, source);
    let bytes = [...this.sources.values()].reduce((sum, value) => sum + value.content.length * 2, 0);
    while (bytes > 16 * 1024 * 1024 || this.sources.size > 100) {
      const first = this.sources.keys().next().value!;
      bytes -= this.sources.get(first)!.content.length * 2; this.sources.delete(first);
    }
    return source;
  }
  private async inventory(): Promise<{ items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: null }> {
    let cursor: string | null = null, sequence: number | undefined;
    const candidates: ReadingItem[] = [];
    const next = new Map<string, WireFile>(), issues: Array<{ path: string; message: string }> = [];
    const nextIndex = new Map<string, { file: WireFile; item: ReadingItem }>();
    const folder = encodeURIComponent(this.options.folderPath);
    let count = 0, metadataBytes = 0;
    do {
      const page: { files: WireFile[]; nextCursor: string | null; generation: number; sequence: number } = await this.json(`/reading/encrypted-files?folderPath=${folder}${cursor ? '&after=' + encodeURIComponent(cursor) : ''}`);
      sequence ??= page.sequence;
      if (!Number.isSafeInteger(page.sequence) || page.sequence !== sequence || page.generation !== this.options.generation || !Array.isArray(page.files) || (count += page.files.length) > 10_000) throw new Error('The encrypted Reading inventory changed or exceeds its limit.');
      for (const file of page.files) {
        if (typeof file.path !== 'string' || !file.path.startsWith(this.options.folderPath + '/') || file.path.split('/').some(p => p === '..' || p === '.') || typeof file.revision !== 'string' || !file.revision || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid encrypted Reading inventory.');
        try {
          next.set(file.path, file);
          const cached = this.indexed.get(file.path);
          const item = cached?.file.revision === file.revision && cached.file.hash === file.hash && cached.file.size === file.size
            ? cached.item : (await this.source(file)).item;
          metadataBytes += new TextEncoder().encode(JSON.stringify(item)).length;
          if (metadataBytes > 12 * 1024 * 1024) throw new Error('Reading metadata exceeds this device’s library limit.');
          candidates.push(item);
          nextIndex.set(file.path, { file, item });
        } catch (error) { issues.push({ path: file.path, message: error instanceof Error ? error.message : 'Article could not be opened.' }); }
      }
      if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor <= (cursor ?? ''))) throw new Error('Reading inventory did not advance.');
      cursor = page.nextCursor;
    } while (cursor);
    if (metadataBytes > 12 * 1024 * 1024) throw new Error('Reading metadata exceeds this device’s library limit.');
    const confirmed = await this.json<{ sequence: number; generation: number }>(`/reading/encrypted-files?folderPath=${folder}`);
    if (confirmed.sequence !== sequence || confirmed.generation !== this.options.generation) throw new Error('Reading changed while loading. Refresh again.');
    this.files = next;
    this.indexed = nextIndex;
    for (const path of this.sources.keys()) if (!next.has(path)) this.sources.delete(path);
    const counts = new Map<string, number>();
    for (const item of candidates) counts.set(item.crate_reading_id, (counts.get(item.crate_reading_id) ?? 0) + 1);
    const items = candidates.flatMap(item => {
      if (counts.get(item.crate_reading_id) === 1) return [item];
      issues.push({ path: item.path, message: 'Several notes have this Reading ID. Resolve the duplicates in Obsidian.' }); return [];
    });
    return { items, issues, cursor: null };
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
          const block = managedArticle(source.content);
          if (item.capture_method !== 'url' || !block || block.text.trim()) throw this.options.error('Only empty saved links can be downloaded.', 409);
          content = patchReadingFrontmatter(source.content, { extraction_status: 'pending' });
        }
        else {
          if (!body.changes || typeof body.changes !== 'object' || !body.before || typeof body.before !== 'object') throw new Error('Choose a Reading change.');
          for (const field of Object.keys(body.changes)) {
            if (!['favorite', 'tags', 'reading_status', 'highlights'].includes(field) || JSON.stringify(item[field as keyof ReadingChanges]) !== JSON.stringify((body.before as Record<string, unknown>)[field])) throw this.options.error('This article changed on another device. Refresh before editing.', 409, 'reading_conflict');
          }
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
