/**
 * Worker script template that gets deployed to Cloudflare
 * This is bundled into the CLI and deployed during `crate init`
 * Uses native Workers API (no external dependencies)
 */

export function getWorkerScript(): string {
	return `
const TOMBSTONES_KEY = '.crate/tombstones.json';
const FILES_PREFIX = 'files/';
const TOMBSTONE_TTL_DAYS = 30;
const UPLOAD_CONCURRENCY = 4;

let dbReady = false;

async function initDb(db) {
	if (dbReady) return;
	await db.exec(\`CREATE TABLE IF NOT EXISTS changelog (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		path TEXT NOT NULL,
		action TEXT NOT NULL,
		hash TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)\`);
	dbReady = true;
}

async function appendChangelog(db, path, action, hash, size) {
	await db.prepare(
		'INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)'
	).bind(path, action, hash || '', size || 0).run();
}

async function runConcurrent(items, concurrency, worker) {
	const results = new Array(items.length);
	let index = 0;
	async function next() {
		while (index < items.length) {
			const i = index++;
			results[i] = await worker(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
	return results;
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	const chunks = [];
	for (let i = 0; i < bytes.byteLength; i += 8192) {
		chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
	}
	return btoa(chunks.join(''));
}

function corsHeaders(origin) {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};
}

function corsResponse(body, status = 200) {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(),
		},
	});
}

async function getTombstones(bucket) {
	const obj = await bucket.get(TOMBSTONES_KEY);
	if (!obj) return { deleted: [] };
	return await obj.json();
}

function pruneTombstones(tombstones, now) {
	tombstones.deleted = tombstones.deleted.filter(
		t => new Date(t.expiresAt) > now
	);
}

async function saveTombstones(bucket, tombstones) {
	await bucket.put(TOMBSTONES_KEY, JSON.stringify(tombstones), {
		httpMetadata: { contentType: 'application/json' },
	});
}

async function clearTombstonesForPaths(bucket, paths) {
	if (!paths.length) return;
	const tombstones = await getTombstones(bucket);
	const now = new Date();
	pruneTombstones(tombstones, now);
	const pathSet = new Set(paths);
	const before = tombstones.deleted.length;
	tombstones.deleted = tombstones.deleted.filter(t => !pathSet.has(t.path));
	if (tombstones.deleted.length !== before) {
		await saveTombstones(bucket, tombstones);
	}
}

async function handleHealth() {
	return corsResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

async function handleCheckChanges(request, db) {
	if (!db) return corsResponse({ error: 'Changelog not available' }, 404);
	await initDb(db);
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);
	const row = await db.prepare('SELECT MAX(seq) as lastSeq FROM changelog').first();
	const lastSeq = row?.lastSeq || 0;
	return corsResponse({ lastSeq, hasChanges: lastSeq > since });
}

async function handleGetChanges(request, db) {
	if (!db) return corsResponse({ error: 'Changelog not available' }, 404);

	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);

	await initDb(db);
	const result = await db.prepare(
		'SELECT seq, path, action, hash, size, created_at FROM changelog WHERE seq > ? ORDER BY seq ASC LIMIT 5000'
	).bind(since).all();

	const maxRow = await db.prepare('SELECT MAX(seq) as lastSeq FROM changelog').first();

	return corsResponse({
		changes: result.results,
		lastSeq: maxRow?.lastSeq || 0,
		hasMore: result.results.length === 5000,
	});
}

async function handleGetManifest(bucket, db) {
	const files = {};
	let cursor = undefined;
	let truncated = true;

	while (truncated) {
		const opts = { prefix: FILES_PREFIX, include: ['customMetadata'] };
		if (cursor) opts.cursor = cursor;
		const listed = await bucket.list(opts);

		for (const object of listed.objects) {
			const path = object.key.slice(FILES_PREFIX.length);
			files[path] = {
				hash: object.customMetadata?.hash || '',
				size: object.size,
				modified: object.uploaded.toISOString(),
			};
		}

		truncated = listed.truncated;
		cursor = listed.cursor;
	}

	let lastSeq = 0;
	if (db) {
		try {
			await initDb(db);
			const row = await db.prepare('SELECT MAX(seq) as lastSeq FROM changelog').first();
			lastSeq = row?.lastSeq || 0;
		} catch (e) { /* ignore */ }
	}

	return corsResponse({ version: 1, files, lastSeq });
}

async function handleUpload(request, bucket, db) {
	const body = await request.json();

	if (!body.files || !Array.isArray(body.files)) {
		return corsResponse({ error: 'Invalid request: files array required' }, 400);
	}

	let changelogEnabled = Boolean(db);
	if (changelogEnabled) {
		try {
			await initDb(db);
		} catch (e) {
			changelogEnabled = false;
		}
	}

	const outcomes = await runConcurrent(body.files, UPLOAD_CONCURRENCY, async file => {
		if (!file.path || file.content === undefined) {
			return { path: file.path, error: 'Missing path or content' };
		}

		try {
			let content;
			if (file.binary) {
				const binaryStr = atob(file.content);
				const bytes = new Uint8Array(binaryStr.length);
				for (let i = 0; i < binaryStr.length; i++) {
					bytes[i] = binaryStr.charCodeAt(i);
				}
				content = bytes;
			} else {
				content = file.content;
			}

			await bucket.put(FILES_PREFIX + file.path, content, {
				httpMetadata: {
					contentType: file.contentType || 'text/plain',
				},
				customMetadata: { hash: file.hash },
			});

			if (changelogEnabled) {
				try {
					await appendChangelog(db, file.path, 'put', file.hash, file.size || 0);
				} catch (e) { /* D1 failure is non-fatal */ }
			}

			return { path: file.path, success: true, uploaded: true };
		} catch (err) {
			const message = err && typeof err.message === 'string' ? err.message : String(err);
			return { path: file.path, error: message };
		}
	});

	const results = outcomes.map(({ uploaded, ...entry }) => entry);
	const uploadedPaths = outcomes
		.filter(entry => entry.uploaded && typeof entry.path === 'string')
		.map(entry => entry.path);

	await clearTombstonesForPaths(bucket, uploadedPaths);

	return corsResponse({ success: true, results });
}

async function handleDownload(request, bucket) {
	const url = new URL(request.url);
	const path = url.searchParams.get('path');

	if (!path) {
		return corsResponse({ error: 'Path query parameter required' }, 400);
	}

	const obj = await bucket.get(FILES_PREFIX + path);

	if (!obj) {
		return corsResponse({ error: 'File not found' }, 404);
	}

	const content = await obj.arrayBuffer();
	const base64 = arrayBufferToBase64(content);

	return corsResponse({
		path,
		content: base64,
		contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
		size: content.byteLength,
	});
}

async function handleDelete(request, bucket, db) {
	const body = await request.json();

	if (!body.path) {
		return corsResponse({ error: 'Path required' }, 400);
	}

	await bucket.delete(FILES_PREFIX + body.path);

	const tombstones = await getTombstones(bucket);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000);
	pruneTombstones(tombstones, now);
	const byPath = new Map();
	for (const tombstone of tombstones.deleted) {
		byPath.set(tombstone.path, tombstone);
	}
	byPath.set(body.path, {
		path: body.path,
		deletedAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
	});
	tombstones.deleted = [...byPath.values()];
	await saveTombstones(bucket, tombstones);

	if (db) {
		try {
			await initDb(db);
			await appendChangelog(db, body.path, 'delete', '', 0);
		} catch (e) { /* D1 failure is non-fatal */ }
	}

	return corsResponse({ success: true, path: body.path });
}

async function handleGetTombstones(bucket) {
	const tombstones = await getTombstones(bucket);
	const now = new Date();
	pruneTombstones(tombstones, now);
	return corsResponse(tombstones);
}

async function handleBatchDownload(request, bucket) {
	const body = await request.json();

	if (!body.paths || !Array.isArray(body.paths)) {
		return corsResponse({ error: 'Paths array required' }, 400);
	}

	const results = [];

	for (const path of body.paths) {
		const obj = await bucket.get(FILES_PREFIX + path);

		if (obj) {
			const content = await obj.arrayBuffer();
			const base64 = arrayBufferToBase64(content);
			results.push({
				path,
				content: base64,
				contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
				size: content.byteLength,
			});
		} else {
			results.push({ path, error: 'Not found' });
		}
	}

	return corsResponse({ files: results });
}

async function handleGetConfig(env) {
	return corsResponse({
		accountId: env.CF_ACCOUNT_ID || null,
		workerName: env.CF_WORKER_NAME || null,
		bucketName: env.CF_BUCKET_NAME || null,
		databaseId: env.CF_DATABASE_ID || null,
	});
}

export default {
	async fetch(request, env) {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		// Auth check
		const authHeader = request.headers.get('Authorization');
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return corsResponse({ error: 'Unauthorized' }, 401);
		}
		const token = authHeader.substring(7);
		if (token !== env.AUTH_TOKEN) {
			return corsResponse({ error: 'Invalid token' }, 401);
		}

		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const bucket = env.BUCKET;
		const db = env.DB || null;

		try {
			if (path === '/health' && method === 'GET') return await handleHealth();
			if (path === '/sync/check' && method === 'GET') return await handleCheckChanges(request, db);
			if (path === '/sync/changes' && method === 'GET') return await handleGetChanges(request, db);
			if (path === '/sync/manifest' && method === 'GET') return await handleGetManifest(bucket, db);
			if (path === '/sync/upload' && method === 'POST') return await handleUpload(request, bucket, db);
			if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket);
			if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket, db);
			if (path === '/sync/tombstones' && method === 'GET') return await handleGetTombstones(bucket);
			if (path === '/sync/batch-download' && method === 'POST') return await handleBatchDownload(request, bucket);
			if (path === '/sync/config' && method === 'GET') return await handleGetConfig(env);

			return corsResponse({ error: 'Not found' }, 404);
		} catch (err) {
			return corsResponse({ error: err.message || 'Internal server error' }, 500);
		}
	},
};
`;
}
