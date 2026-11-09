import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import type { EncryptionServerState } from '@/encryption/server-state';
import { corsHeaders } from '../http/cors';
import { parseJsonObject } from '../http/request-validation';
import { readingNotModified, readingResponse, ReadingError } from './common';
import { changedPathsSince, readVaultChangeState } from '../sync/change-token';
import { completeReadingIndex, readingIndexStatement, type ReadingIndexRow } from './library-index';
import { etagMatches, listedPage, queuedStatement, readingDeltaBase, readingListEtag, ROW_COLUMNS, type ReadingRow } from './queries';
import { portablePathKey } from '@/protocol/portable-path';
import { sha256Hex } from '@/platform/sha256';
import { READING_INDEX_MANIFEST_KEY, readingIndexShardKey } from '@/protocol/storage-keys';
import {
	isReadingIndexHash, MAX_READING_INDEX_MANIFEST_BYTES, MAX_READING_INDEX_SHARD_BYTES, MAX_READING_INDEX_TAIL_PATHS,
	parseReadingIndexManifest, READING_INDEX_EMPTY_SHARD, type ReadingIndexManifest,
} from '@/protocol/reading-index';

/** A replaced shard stays this long, so a web app reading the manifest it replaced still finds it. */
const RETIRED_SHARD_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_RETIRED_SHARDS = 1_024;

/** What the server keeps beside the published fields: the vault's change state the basis
 * belongs to, and replaced shards waiting to be deleted. */
interface StoredManifest extends ReadingIndexManifest {
	vault: { reset: string; import: number };
	retired: Array<{ hash: string; at: number }>;
}

function storedManifest(value: unknown): StoredManifest | null {
	const manifest = parseReadingIndexManifest(value);
	if (!manifest) return null;
	const { vault, retired } = value as Partial<StoredManifest>;
	if (!vault || typeof vault.reset !== 'string' || typeof vault.import !== 'number' || !Array.isArray(retired)) return null;
	if (!retired.every(entry => entry && isReadingIndexHash(entry.hash) && typeof entry.at === 'number')) return null;
	return { ...manifest, vault, retired };
}

async function readManifest(env: Env): Promise<{ manifest: StoredManifest; etag: string; httpEtag: string } | null> {
	const object = await env.BUCKET.get(READING_INDEX_MANIFEST_KEY);
	if (!object) return null;
	let value: unknown;
	try { value = JSON.parse(await object.text()); } catch { return null; }
	const manifest = storedManifest(value);
	return manifest ? { manifest, etag: object.etag, httpEtag: `"${object.etag}"` } : null;
}

const published = ({ vault: _vault, retired: _retired, ...manifest }: StoredManifest): ReadingIndexManifest => manifest;
const missing = () => readingResponse({ error: 'This library has no card index yet.', code: 'reading_index_missing' }, 404);

/** Whether the manifest still describes this folder, its keys and this changelog. */
function current(manifest: StoredManifest, policy: ReadingPolicy, encryption: EncryptionServerState | null, state: { resetGeneration: string; importGeneration: number; seq: number }): boolean {
	return manifest.generation === policy.generation && manifest.vault.reset === state.resetGeneration && manifest.vault.import === state.importGeneration
		&& manifest.basis <= state.seq && (encryption ? manifest.keyGeneration === encryption.generation : manifest.keyGeneration === undefined);
}

/**
 * The Reading card index routes. Shards and the manifest live in R2: reading the manifest
 * costs no D1 rows beyond the change state, and a shard read costs none. Only the tail reads
 * rows, one per vault change since the manifest's basis.
 */
export async function handleReadingIndex(request: Request, env: Env, principal: AuthPrincipal, policy: ReadingPolicy, encryption: EncryptionServerState | null): Promise<Response> {
	const url = new URL(request.url), path = url.pathname;
	const writer = () => { if (principal.scope !== 'vault') throw new ReadingError('Only Obsidian publishes the Reading index.', 403); };
	if (path === '/reading/index' && request.method === 'GET') {
		const [stored, state] = await Promise.all([readManifest(env), readVaultChangeState(env.DB)]);
		if (!stored || !current(stored.manifest, policy, encryption, state)) return missing();
		if (etagMatches(request.headers.get('If-None-Match'), stored.httpEtag)) return readingNotModified(stored.httpEtag);
		return readingResponse({ manifest: published(stored.manifest), etag: stored.etag }, 200, { ETag: stored.httpEtag });
	}
	if (path === '/reading/index' && request.method === 'PUT') {
		writer();
		return publishManifest(request, env, policy, encryption);
	}
	if (path === '/reading/index/shard') {
		const hash = url.searchParams.get('hash');
		if (!isReadingIndexHash(hash)) throw new ReadingError('Invalid shard.');
		if (request.method === 'GET') {
			const object = await env.BUCKET.get(readingIndexShardKey(hash));
			if (!object) return readingResponse({ error: 'Shard not found.', code: 'reading_index_shard_missing' }, 404);
			// Content-addressed, so a browser may keep it for good.
			return new Response(object.body, { headers: { ...corsHeaders(), 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${object.etag}"` } });
		}
		if (request.method === 'PUT') {
			writer();
			const declared = request.headers.get('Content-Length');
			if (declared !== null && Number(declared) > MAX_READING_INDEX_SHARD_BYTES) throw new ReadingError('Shard is too large.', 413);
			const bytes = new Uint8Array(await request.arrayBuffer());
			if (!bytes.byteLength || bytes.byteLength > MAX_READING_INDEX_SHARD_BYTES) throw new ReadingError('Shard is too large.', 413);
			if (await sha256Hex(bytes) !== hash) throw new ReadingError('Shard does not match its hash.');
			await env.BUCKET.put(readingIndexShardKey(hash), bytes);
			return new Response(null, { status: 204, headers: corsHeaders() });
		}
	}
	if (path === '/reading/index/changes' && request.method === 'GET') {
		const after = Number(url.searchParams.get('after'));
		if (!Number.isSafeInteger(after) || after < 0) throw new ReadingError('Invalid change position.');
		return encryption ? encryptedTail(env, policy, after) : plainTail(env, policy, after);
	}
	if (path === '/reading/index/file' && request.method === 'GET') {
		if (!encryption) throw new ReadingError('File details are only for encrypted Reading folders.', 409);
		const file = url.searchParams.get('path');
		if (!file || !file.startsWith(`${policy.folder_path}/`)) throw new ReadingError('Unknown encrypted Reading file.', 403);
		const [row] = await wireFiles(env, [file]);
		return row ? readingResponse({ file: row }) : readingResponse({ error: 'Not found' }, 404);
	}
	return readingResponse({ error: 'Not found' }, 404);
}

/** Publishes a manifest whose new shards were uploaded, only over the version the plugin read. */
async function publishManifest(request: Request, env: Env, policy: ReadingPolicy, encryption: EncryptionServerState | null): Promise<Response> {
	const parsed = await parseJsonObject(request, MAX_READING_INDEX_MANIFEST_BYTES);
	if (!parsed.ok) return parsed.response;
	const { manifest: value, expected } = parsed.value;
	const manifest = parseReadingIndexManifest(value);
	if (!manifest || (expected !== null && typeof expected !== 'string')) throw new ReadingError('Invalid Reading index.');
	const [previous, state] = await Promise.all([readManifest(env), readVaultChangeState(env.DB)]);
	const stamp = { reset: state.resetGeneration, import: state.importGeneration };
	if (manifest.generation !== policy.generation || manifest.basis > state.seq
		|| (encryption ? manifest.keyGeneration !== encryption.generation : manifest.keyGeneration !== undefined)) {
		throw new ReadingError('This Reading index belongs to another folder setup or key.', 409, 'reading_index_stale');
	}
	if ((previous?.etag ?? null) !== expected) {
		return readingResponse({ error: 'Another device published the Reading index.', code: 'reading_index_conflict', etag: previous?.etag ?? null }, 409);
	}
	// Every new shard must be stored before the manifest names it.
	const known = new Set(previous?.manifest.shards ?? []);
	const added = [...new Set(manifest.shards.filter(hash => hash !== READING_INDEX_EMPTY_SHARD && !known.has(hash)))];
	const found = await Promise.all(added.map(hash => env.BUCKET.head(readingIndexShardKey(hash))));
	if (found.some(object => !object)) throw new ReadingError('Upload every new shard before publishing.', 409, 'reading_index_shard_missing');
	const now = Date.now(), referenced = new Set(manifest.shards);
	const replaced = (previous?.manifest.shards ?? []).filter(hash => hash !== READING_INDEX_EMPTY_SHARD && !referenced.has(hash)).map(hash => ({ hash, at: now }));
	const waiting = [...previous?.manifest.retired ?? [], ...replaced].filter(entry => !referenced.has(entry.hash));
	const expired = waiting.filter(entry => now - entry.at >= RETIRED_SHARD_GRACE_MS).map(entry => entry.hash);
	const retired = waiting.filter(entry => now - entry.at < RETIRED_SHARD_GRACE_MS).slice(-MAX_RETIRED_SHARDS);
	const stored: StoredManifest = { ...manifest, vault: stamp, retired };
	const written = await env.BUCKET.put(READING_INDEX_MANIFEST_KEY, JSON.stringify(stored), {
		onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
	});
	if (!written) return readingResponse({ error: 'Another device published the Reading index.', code: 'reading_index_conflict', etag: null }, 409);
	// Deleting after the commit: a failure here leaves a shard for the next publish to retire.
	if (expired.length) await env.BUCKET.delete([...new Set(expired)].map(readingIndexShardKey)).catch(() => {});
	return readingResponse({ etag: written.etag });
}

async function changedPaths(env: Env, policy: ReadingPolicy, after: number): Promise<{ paths: string[]; lastSeq: number } | Response> {
	const state = await readVaultChangeState(env.DB);
	const paths = await changedPathsSince(env.DB, policy.folder_path, after, state.bounds);
	if (!paths) return readingResponse({ expired: true, lastSeq: state.seq });
	if (paths.length > MAX_READING_INDEX_TAIL_PATHS) return readingResponse({ tooMany: true, lastSeq: state.seq });
	return { paths, lastSeq: state.seq };
}

/** Rows by primary key, so a tail reads one row per changed note. */
async function wireFiles(env: Env, paths: string[]) {
	if (!paths.length) return [];
	const { results } = await env.DB.prepare(`SELECT path, hash, size, storage_key AS revision, modified FROM files
    WHERE portable_path IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(paths.map(portablePathKey)))
		.all<{ path: string; hash: string; size: number; revision: string; modified: string }>();
	return results;
}

/** Encrypted vaults: the changed files, which the web app downloads and opens. */
async function encryptedTail(env: Env, policy: ReadingPolicy, after: number): Promise<Response> {
	const changed = await changedPaths(env, policy, after);
	if (changed instanceof Response) return changed;
	const files = await wireFiles(env, changed.paths);
	const present = new Set(files.map(file => file.path));
	return readingResponse({ lastSeq: changed.lastSeq, notes: files, removed: changed.paths.filter(path => !present.has(path)) });
}

/** Unencrypted vaults: the changed notes' cards from the server's Reading index, plus the
 * list ETag and change base, so later refreshes use the ordinary list delta. The index
 * position is read first: anything after it replays in that delta, which is idempotent. */
async function plainTail(env: Env, policy: ReadingPolicy, after: number): Promise<Response> {
	const index = completeReadingIndex(policy, await readingIndexStatement(env.DB).first<ReadingIndexRow>());
	// A missing or rebuilding server index cannot answer; the web app lists the library instead.
	if (!index) return readingResponse({ expired: true });
	const changed = await changedPaths(env, policy, after);
	if (changed instanceof Response) return changed;
	const [{ results: rows }, { results: queued }] = await env.DB.batch([
		env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM reading_items WHERE portable_path IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(changed.paths.map(portablePathKey))),
		queuedStatement(env, policy),
	]) as [{ results: ReadingRow[] }, { results: Array<{ note: string }> }];
	const page = listedPage(policy, rows, queued);
	const present = new Set(rows.map(row => row.path));
	return readingResponse({ lastSeq: changed.lastSeq, notes: page.items, issues: page.issues, removed: changed.paths.filter(path => !present.has(path)),
		changedPaths: changed.paths, revision: await readingListEtag(policy, index.revision), deltaBase: await readingDeltaBase(policy, index) });
}
