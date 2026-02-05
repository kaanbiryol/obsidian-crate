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

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
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

async function handleHealth() {
	return corsResponse({ status: 'ok', timestamp: new Date().toISOString() });
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

	const results = [];

	for (const file of body.files) {
		if (!file.path || file.content === undefined) {
			results.push({ path: file.path, error: 'Missing path or content' });
			continue;
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

			results.push({ path: file.path, success: true });

			if (db) {
				try {
					await initDb(db);
					await appendChangelog(db, file.path, 'put', file.hash, file.size || 0);
				} catch (e) { /* D1 failure is non-fatal */ }
			}
		} catch (err) {
			results.push({ path: file.path, error: err.message });
		}
	}

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
	const base64 = btoa(String.fromCharCode(...new Uint8Array(content)));

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

	tombstones.deleted.push({
		path: body.path,
		deletedAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
	});

	tombstones.deleted = tombstones.deleted.filter(
		t => new Date(t.expiresAt) > now
	);

	await bucket.put(TOMBSTONES_KEY, JSON.stringify(tombstones), {
		httpMetadata: { contentType: 'application/json' },
	});

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
	tombstones.deleted = tombstones.deleted.filter(
		t => new Date(t.expiresAt) > now
	);
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
			const base64 = btoa(String.fromCharCode(...new Uint8Array(content)));
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
			if (path === '/sync/changes' && method === 'GET') return await handleGetChanges(request, db);
			if (path === '/sync/manifest' && method === 'GET') return await handleGetManifest(bucket, db);
			if (path === '/sync/upload' && method === 'POST') return await handleUpload(request, bucket, db);
			if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket);
			if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket, db);
			if (path === '/sync/tombstones' && method === 'GET') return await handleGetTombstones(bucket);
			if (path === '/sync/batch-download' && method === 'POST') return await handleBatchDownload(request, bucket);

			return corsResponse({ error: 'Not found' }, 404);
		} catch (err) {
			return corsResponse({ error: err.message || 'Internal server error' }, 500);
		}
	},
};
`;
}
