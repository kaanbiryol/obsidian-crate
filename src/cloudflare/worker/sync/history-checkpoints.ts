import { CHECKPOINT_RETENTION_MS, MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_FILES, MAX_ENCRYPTED_CHECKPOINT_BYTES, MAX_SHARED_CHECKPOINTS, isCheckpointId,
    parseSharedCheckpointList, type SharedCheckpoint } from '../../../protocol/history-checkpoints';
import type { FileEntry } from '../../../protocol/sync-types';
import { portablePathKey } from '../../../protocol/portable-path';
import { corsHeaders, corsResponse } from '../cors';
import { fileTransportLimit } from '../../../encryption/file-format';
import { storedObjectMatchesMetadata } from './storage';
import { sanitizePath } from '../utils';
import { isSyncRevision } from '../../../protocol/sync-validation';
import { HISTORY_CHECKPOINT_PREFIX, HISTORY_INDEX_KEY } from '../../../protocol/storage-keys';

const PREFIX = HISTORY_CHECKPOINT_PREFIX;
// Ten pages cover the largest checkpoint within the Free plan's query budget.
export const CHECKPOINT_PAGE_SIZE = 10_000;
const MAX_STORED_CHECKPOINT_BYTES = MAX_ENCRYPTED_CHECKPOINT_BYTES + 4096;
const keyFor = (id: string) => `${PREFIX}${id}.json`;
const headers = { 'Cache-Control': 'private, no-store' };
const response = (value: unknown, status = 200) => corsResponse(value, status, headers);

async function readIndex(bucket: R2Bucket) {
    const object = await bucket.get(HISTORY_INDEX_KEY);
    if (!object) return { checkpoints: [] as SharedCheckpoint[], etag: undefined };
    if (object.size > 32_768) throw new Error('Invalid checkpoint index');
    return { checkpoints: parseSharedCheckpointList(JSON.parse(await object.text())), etag: object.etag };
}

async function generation(db: D1Database) {
    const row = await db.prepare(`SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'changelog'), 0) AS sequence,
        COALESCE((SELECT state FROM initial_import WHERE id = 1), 'complete') AS state,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS now`).first<{ sequence: number; state: string; now: number }>();
    if (!row) throw new Error('Could not read checkpoint generation');
    return row;
}

/** Snapshot authoritative metadata only. Every page must belong to one generation. */
export async function createSharedCheckpoint(bucket: R2Bucket, db: D1Database): Promise<Response> {
    const start = await generation(db);
    if (start.state !== 'complete') return response({ error: 'Finish the initial sync before creating a checkpoint.' }, 409);
    const existing = (await readIndex(bucket)).checkpoints.find(entry => entry.sequence === start.sequence && entry.expiresAt > start.now);
    if (existing) return response({ checkpoint: existing });
    // Encode rows as they are read: the inventory is never held as both objects
    // and a serialized document, keeping a 100k-file checkpoint within memory.
    const encoder = new TextEncoder();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let after = '', size = 0, fileCount = 0;
    while (true) {
        const page = await db.prepare(`SELECT path, hash, size, modified, storage_key AS revision FROM files
            WHERE portable_path > ? ORDER BY portable_path LIMIT ?`).bind(after, CHECKPOINT_PAGE_SIZE).all<FileEntry & { path: string }>();
        for (const { path, hash, size: bytes, modified, revision } of page.results) {
            const part = encoder.encode(`${fileCount ? ',' : ''}${JSON.stringify(path)}:${JSON.stringify({ hash, size: bytes, modified, revision })}`);
            parts.push(part);
            size += part.byteLength;
            fileCount++;
        }
        if (fileCount > MAX_CHECKPOINT_FILES || size > MAX_CHECKPOINT_BYTES - 4096) return response({ error: 'This vault exceeds the shared checkpoint limit (100,000 files or 32 MiB of metadata).' }, 413);
        if (page.results.length < CHECKPOINT_PAGE_SIZE) break;
        after = portablePathKey(page.results.at(-1)!.path);
    }
    const end = await generation(db);
    if (end.sequence !== start.sequence || end.state !== start.state) return response({ error: 'The vault changed while saving its checkpoint. Sync again to retry.' }, 409);
    const checkpoint: SharedCheckpoint = { id: crypto.randomUUID(), sequence: start.sequence, timestamp: new Date(start.now).toISOString(),
        expiresAt: start.now + CHECKPOINT_RETENTION_MS, fileCount };
    // Index metadata travels with the object, so reads can verify it without parsing.
    await bucket.put(keyFor(checkpoint.id), new Blob([`{"version":1,"checkpoint":${JSON.stringify(checkpoint)},"files":{`, ...parts, '}}']), {
        httpMetadata: { contentType: 'application/json' }, customMetadata: { checkpoint: JSON.stringify(checkpoint) } });
    // Publish only after the complete inventory exists. Failed/uncertain index
    // writes leave the object for delayed collection, never delete a possible commit.
    for (let attempt = 0; attempt < 5; attempt++) {
        const index = await readIndex(bucket);
        const current = index.checkpoints.filter(entry => entry.expiresAt > Date.now());
        const duplicate = current.find(entry => entry.sequence === checkpoint.sequence);
        if (duplicate) return response({ checkpoint: duplicate });
        const checkpoints = [...current, checkpoint].sort((a, b) => b.sequence - a.sequence || b.timestamp.localeCompare(a.timestamp)).slice(0, MAX_SHARED_CHECKPOINTS);
        if (!checkpoints.some(entry => entry.id === checkpoint.id)) return response({ error: 'Newer checkpoints replaced this state. Sync again.' }, 409);
        const written = await bucket.put(HISTORY_INDEX_KEY, JSON.stringify({ version: 1, checkpoints }), {
            onlyIf: index.etag ? { etagMatches: index.etag } : { etagDoesNotMatch: '*' },
            httpMetadata: { contentType: 'application/json' },
        });
        if (written) return response({ checkpoint });
    }
    return response({ error: 'Checkpoint history is busy. Sync again to retry.' }, 409);
}

export async function listSharedCheckpoints(bucket: R2Bucket): Promise<Response> {
    const index = await readIndex(bucket);
    return response({ version: 1, checkpoints: index.checkpoints.filter(entry => entry.expiresAt > Date.now()) });
}

/** Streams the stored document after matching its metadata to the live index entry. */
export async function getSharedCheckpoint(request: Request, bucket: R2Bucket): Promise<Response> {
    const id = new URL(request.url).searchParams.get('id');
    if (!isCheckpointId(id)) return response({ error: 'Invalid checkpoint ID' }, 400);
    const entry = (await readIndex(bucket)).checkpoints.find(entry => entry.id === id && entry.expiresAt > Date.now());
    if (!entry) return response({ error: 'This shared checkpoint expired or was replaced by a newer checkpoint.' }, 410);
    return streamCheckpointObject(bucket, keyFor(id), JSON.stringify(entry));
}

export async function streamCheckpointObject(bucket: R2Bucket, key: string, expected?: string): Promise<Response> {
    const object = await bucket.get(key);
    if (!object || object.size > MAX_STORED_CHECKPOINT_BYTES) throw new Error('Shared checkpoint is unavailable');
    const metadata = object.customMetadata?.checkpoint;
    if (!metadata || (expected !== undefined && metadata !== expected)) {
        await object.body?.cancel();
        throw new Error('Checkpoint metadata does not match its index');
    }
    return new Response(object.body, { headers: { ...corsHeaders(), ...headers, 'Content-Type': 'application/json', 'Content-Length': String(object.size) } });
}

/** Wraps client ciphertext without parsing either document; the plaintext
 * object is replaced only after the encrypted bytes are validated. */
export async function storeEncryptedCheckpoint(bucket: R2Bucket, key: string, encrypted: Uint8Array<ArrayBuffer>): Promise<Response> {
    const object = await bucket.head(key);
    if (!object) return response({ error: 'Checkpoint is unavailable' }, 404);
    if (object.customMetadata?.encrypted === '1') return response({ success: true });
    const checkpoint = object.customMetadata?.checkpoint;
    if (!checkpoint || !isEnvelopeText(encrypted)) return response({ error: 'Invalid encrypted checkpoint' }, 400);
    await bucket.put(key, new Blob([`{"version":1,"checkpoint":${checkpoint},"encrypted":"`, encrypted, '"}']), {
        httpMetadata: { contentType: 'application/json' }, customMetadata: { checkpoint, encrypted: '1' } });
    return response({ success: true });
}

/** A five-part base64url envelope needs no JSON escaping. */
function isEnvelopeText(bytes: Uint8Array): boolean {
    let dots = 0;
    for (const byte of bytes) {
        if (byte === 0x2e) dots++;
        else if (!(byte >= 0x30 && byte <= 0x39 || byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a || byte === 0x2d || byte === 0x5f)) return false;
    }
    return dots === 4 && bytes.byteLength <= MAX_ENCRYPTED_CHECKPOINT_BYTES;
}

/** Vault-scoped immutable reads; validate the live checkpoint and D1 ownership.
 * The client checks the returned bytes against its verified checkpoint inventory.
 * Avoid reading the entire inventory once per restored file. */
export async function downloadCheckpointFile(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const id = params.get('id'), path = sanitizePath(params.get('path') ?? ''), revision = params.get('revision');
    if (!isCheckpointId(id) || !path || !isSyncRevision(revision)) return response({ error: 'A checkpoint and file path are required' }, 400);
    const checkpoint = (await readIndex(bucket)).checkpoints.find(entry => entry.id === id && entry.expiresAt > Date.now());
    if (!checkpoint) return response({ error: 'This shared checkpoint expired or was replaced.' }, 410);
    const file = await db.prepare(`SELECT hash, size FROM files WHERE portable_path = ? AND path = ? AND storage_key = ?
        UNION ALL SELECT hash, size FROM file_versions WHERE storage_key = ? AND path = ? AND expires_at > ? LIMIT 1`)
        .bind(portablePathKey(path), path, revision, revision, path, Date.now()).first<{ hash: string; size: number }>();
    if (!file) return response({ error: 'A file version required by this checkpoint is no longer available.' }, 410);
    const object = await bucket.get(revision);
    if (!object || object.size > fileTransportLimit(object.httpMetadata?.contentType) || !storedObjectMatchesMetadata(object, { hash: file.hash, size: file.size, storageKey: revision })) return response({ error: 'Checkpoint file contents are unavailable.' }, 503);
    return new Response(object.body, { headers: { ...corsHeaders(), ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), 'X-File-Hash': file.hash } });
}

/** Bounded sweep. Objects younger than a day may still be publishing their index. */
export async function pruneSharedCheckpoints(bucket: R2Bucket, db: D1Database): Promise<void> {
    const cursorKey = 'shared_checkpoint_cleanup_cursor';
    const cursor = (await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(cursorKey).first<{ value: string }>())?.value;
    const listing = await bucket.list({ prefix: PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
    const index = await readIndex(bucket);
    const retained = new Set(index.checkpoints.filter(entry => entry.expiresAt > Date.now()).map(entry => keyFor(entry.id)));
    const garbage = listing.objects.filter(object => object.uploaded.getTime() < Date.now() - 86_400_000 && !retained.has(object.key));
    if (garbage.length) await bucket.delete(garbage.map(object => object.key));
    if (listing.truncated) await db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(cursorKey, listing.cursor).run();
    else await db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(cursorKey).run();
}
