import { portablePathKey } from '../../protocol/portable-path';
import type { BatchUploadResponse } from '@/protocol/sync-types';
import { BATCH_UPLOAD_MAX_BYTES, MAX_FILE_SIZE_BYTES } from '@/protocol/sync-limits';
import { INITIAL_IMPORT_MAX_FILES } from '@/protocol/initial-import';
import { corsResponse } from './cors';
import { isSha256Hex, parseJsonObject, sanitizePath } from './utils';
import { sha256HexBytes } from './auth';
import { readInitialImport } from './initial-import';
import { createManagedObjectKey, loadStoredFileRows, parseExpectedFileHash } from './sync-storage';
import { trackStagedBatch, finishStagedBatches } from './staged-upload-batches';
import { uploadMutation } from './sync-mutations';
import { readLimitedRequestBody } from './body-reader';

interface ImportFile {
  path: string; hash: string; size: number; content: ArrayBuffer;
  contentType: string; expectedHash: string | null;
}

export async function uploadInitialFiles(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
  const token = request.headers.get('X-Crate-Import');
  const current = await readInitialImport(db);
  if (!current || current.token !== token || current.state !== 'importing') return corsResponse({ error: 'Initial import is closed or unavailable' }, 409);
  const input: Array<Record<string, unknown>> = [];
  if (request.method === 'PUT') {
    // Large attachments use a binary request, without base64 copies in memory.
    const body = await readLimitedRequestBody(request, MAX_FILE_SIZE_BYTES, 'File exceeds 25MB limit');
    if (!body.ok) return body.response;
    input.push({ path: new URL(request.url).searchParams.get('path'),
      hash: request.headers.get('X-File-Hash'), content: body.bytes.buffer,
      contentType: request.headers.get('Content-Type'), expectedHash: parseExpectedFileHash(request.headers.get('X-Crate-Expected-Hash')) });
  } else {
    const parsed = await parseJsonObject(request, 15 * 1024 * 1024);
    if (!parsed.ok) return parsed.response;
    if (!Array.isArray(parsed.value.files) || !parsed.value.files.length || parsed.value.files.length > INITIAL_IMPORT_MAX_FILES) {
      return corsResponse({ error: 'Invalid import batch' }, 400);
    }
    for (const value of parsed.value.files as unknown[]) {
      if (!value || typeof value !== 'object') return corsResponse({ error: 'Invalid import file' }, 400);
      input.push(value as Record<string, unknown>);
    }
  }
  const files: ImportFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const value of input) {
    const path = typeof value.path === 'string' ? sanitizePath(value.path) : null;
    const expectedHash = parseExpectedFileHash(value.expectedHash);
    if (!path || paths.has(path) || expectedHash === undefined || typeof value.hash !== 'string' || !isSha256Hex(value.hash)) {
      return corsResponse({ error: 'Invalid import metadata' }, 400);
    }
    paths.add(path);
    let content: ArrayBuffer;
    try {
      if (value.content instanceof ArrayBuffer) content = value.content;
      else {
        const binary = atob(value.content as string);
        const bytes = new Uint8Array(binary.length);
        // Array.from's per-byte callback/iterator exhausted the hosted Free CPU budget.
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        content = bytes.buffer;
      }
    } catch { return corsResponse({ error: 'Invalid import content' }, 400); }
    total += content.byteLength;
    if (content.byteLength > MAX_FILE_SIZE_BYTES || request.method !== 'PUT' && total > BATCH_UPLOAD_MAX_BYTES) return corsResponse({ error: 'Import payload too large' }, 413);
    if (await sha256HexBytes(content) !== value.hash) return corsResponse({ error: 'Import content hash mismatch' }, 400);
    files.push({ path, hash: value.hash, size: content.byteLength, content,
      contentType: typeof value.contentType === 'string' ? value.contentType : 'application/octet-stream', expectedHash });
  }
  return commitImportFiles(token, files, bucket, db);
}

async function commitImportFiles(token: string, files: ImportFile[], bucket: R2Bucket, db: D1Database): Promise<Response> {
  const previous = await loadStoredFileRows(db, files.map(file => file.path));
  const results: BatchUploadResponse['results'] = [];
  const pending = files.filter(file => {
    const prior = previous.get(file.path);
    if (prior?.hash !== file.hash || prior.size !== file.size) return true;
    results.push({ path: file.path, success: true, hash: file.hash, revision: prior.storageKey });
    return false;
  }).map(file => ({ ...file, objectKey: createManagedObjectKey(file.hash) }));
  if (!pending.length) return corsResponse({ success: true, results });
  const stagingBatchId = await trackStagedBatch(db, pending.map(file => ({ storageKey: file.objectKey, path: file.path })));
  const staged: typeof pending = [];
  for (let offset = 0; offset < pending.length; offset += 3) {
    await Promise.all(pending.slice(offset, offset + 3).map(async file => {
      try {
        await bucket.put(file.objectKey, file.content, { httpMetadata: { contentType: file.contentType }, customMetadata: { hash: file.hash } });
        staged.push(file);
      } catch { results.push({ path: file.path, success: false, code: 'storage', status: 503, error: 'Upload interrupted. Sync again to resume.' }); }
    }));
  }
  if (staged.length) {
    const json = JSON.stringify(staged.map(file => ({ path: file.path, portable: portablePathKey(file.path), key: file.objectKey, old: previous.get(file.path)?.storageKey ?? null })));
    await db.batch([
      ...staged.map(file => uploadMutation(db, file.path, file.hash, file.size, file.objectKey, file.expectedHash, undefined, undefined, stagingBatchId, token)),
      db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue(storage_key, file_path)
        SELECT json_extract(i.value, '$.old'), json_extract(i.value, '$.path') FROM json_each(?) i JOIN files f
        ON f.portable_path = json_extract(i.value, '$.portable') AND f.path = json_extract(i.value, '$.path') AND f.storage_key = json_extract(i.value, '$.key')
        WHERE json_extract(i.value, '$.old') IS NOT NULL`).bind(json),
      ...finishStagedBatches(db, staged.map(file => ({ ...file, stagingBatchId }))),
      db.prepare("UPDATE initial_import SET generation = generation + 1 WHERE token = ? AND state = 'importing'").bind(token),
    ]);
    const committed = await loadStoredFileRows(db, staged.map(file => file.path));
    for (const file of staged) {
      const row = committed.get(file.path);
      results.push(row?.hash === file.hash && row.size === file.size
        ? { path: file.path, success: true, hash: file.hash, revision: row.storageKey }
        : { path: file.path, success: false, code: 'version_conflict', status: 409, error: 'Import file changed. Sync again to compare and resume.' });
    }
  }
  return corsResponse({ success: results.every(result => result.success), results });
}
