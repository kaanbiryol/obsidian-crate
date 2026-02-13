/**
 * Worker script template deployed by in-plugin setup and deploy actions.
 * Kept in sync with the CLI template.
 */

export function getWorkerScript(): string {
	return `
const TOMBSTONES_KEY = '.crate/tombstones.json';
const MANIFEST_CACHE_KEY = '.crate/manifest-cache.json';
const FILES_PREFIX = 'files/';
const TOMBSTONE_TTL_DAYS = 30;
const CHANGELOG_RETENTION_DAYS = 30;

let dbReady = false;

function sanitizePath(path) {
	if (!path || typeof path !== 'string') return null;
	if (path.includes('\\0')) return null;
	const segments = path.split('/').reduce((acc, seg) => {
		if (seg === '..') { acc.pop(); }
		else if (seg !== '.' && seg !== '') { acc.push(seg); }
		return acc;
	}, []);
	if (segments.length === 0) return null;
	return segments.join('/');
}

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

async function maybePruneChangelog(db) {
	if (Math.random() > 0.05) return;
	try {
		await db.prepare(
			"DELETE FROM changelog WHERE created_at < datetime('now', '-' || ? || ' days')"
		).bind(CHANGELOG_RETENTION_DAYS).run();
	} catch (e) { /* non-fatal */ }
}

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Hash, X-File-Size',
		'Access-Control-Expose-Headers': 'X-File-Hash, X-File-Size, Content-Type, Content-Length',
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

async function invalidateManifestCache(bucket) {
	try {
		await bucket.delete(MANIFEST_CACHE_KEY);
	} catch (e) { /* non-fatal */ }
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

async function getManifestCache(bucket) {
	try {
		const obj = await bucket.get(MANIFEST_CACHE_KEY);
		if (!obj) return null;
		const cache = await obj.json();
		if (cache && typeof cache === 'object' && cache.files) return cache;
		return null;
	} catch (e) {
		return null;
	}
}

async function saveManifestCache(bucket, files) {
	try {
		await bucket.put(MANIFEST_CACHE_KEY, JSON.stringify({ files }), {
			httpMetadata: { contentType: 'application/json' },
		});
	} catch (e) { /* non-fatal */ }
}

async function handleGetManifest(bucket, db) {
	let files;
	const cache = await getManifestCache(bucket);
	if (cache) {
		files = cache.files;
	} else {
		const allFiles = {};
		let cursor = undefined;
		let truncated = true;

		while (truncated) {
			const opts = { prefix: FILES_PREFIX, include: ['customMetadata'] };
			if (cursor) opts.cursor = cursor;
			const listed = await bucket.list(opts);

			for (const object of listed.objects) {
				const path = object.key.slice(FILES_PREFIX.length);
				allFiles[path] = {
					hash: object.customMetadata?.hash || '',
					size: object.size,
					modified: object.uploaded.toISOString(),
				};
			}

			truncated = listed.truncated;
			cursor = listed.cursor;
		}

		files = allFiles;
		await saveManifestCache(bucket, files);
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
	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');

	if (!rawPath) {
		return corsResponse({ error: 'Path query parameter required' }, 400);
	}

	const safePath = sanitizePath(rawPath);
	if (!safePath) {
		return corsResponse({ error: 'Invalid path' }, 400);
	}

	const hash = request.headers.get('X-File-Hash') || '';
	const size = parseInt(request.headers.get('X-File-Size') || '0', 10);
	const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

	try {
		// Stream request body directly to R2 — zero memory buffering
		await bucket.put(FILES_PREFIX + safePath, request.body, {
			httpMetadata: { contentType },
			customMetadata: { hash },
		});

		let changelogEnabled = Boolean(db);
		if (changelogEnabled) {
			try {
				await initDb(db);
				await appendChangelog(db, safePath, 'put', hash, size);
				await maybePruneChangelog(db);
			} catch (e) { /* D1 failure is non-fatal */ }
		}

		await clearTombstonesForPaths(bucket, [safePath]);

		// Invalidate manifest cache instead of read-modify-write (fixes race condition)
		await invalidateManifestCache(bucket);

		return corsResponse({ success: true, path: safePath, hash });
	} catch (err) {
		const message = err && typeof err.message === 'string' ? err.message : String(err);
		return corsResponse({ success: false, path: safePath, error: message }, 500);
	}
}

async function handleDownload(request, bucket) {
	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');

	if (!rawPath) {
		return corsResponse({ error: 'Path query parameter required' }, 400);
	}

	const path = sanitizePath(rawPath);
	if (!path) {
		return corsResponse({ error: 'Invalid path' }, 400);
	}

	const obj = await bucket.get(FILES_PREFIX + path);

	if (!obj) {
		return corsResponse({ error: 'File not found' }, 404);
	}

	// Stream R2 body directly to response — zero memory buffering
	return new Response(obj.body, {
		status: 200,
		headers: {
			'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
			'Content-Length': String(obj.size),
			'X-File-Hash': obj.customMetadata?.hash || '',
			...corsHeaders(),
		},
	});
}

async function handleDelete(request, bucket, db) {
	const body = await request.json();

	if (!body.path) {
		return corsResponse({ error: 'Path required' }, 400);
	}

	const safePath = sanitizePath(body.path);
	if (!safePath) {
		return corsResponse({ error: 'Invalid path' }, 400);
	}

	await bucket.delete(FILES_PREFIX + safePath);

	const tombstones = await getTombstones(bucket);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000);
	pruneTombstones(tombstones, now);
	const byPath = new Map();
	for (const tombstone of tombstones.deleted) {
		byPath.set(tombstone.path, tombstone);
	}
	byPath.set(safePath, {
		path: safePath,
		deletedAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
	});
	tombstones.deleted = [...byPath.values()];
	await saveTombstones(bucket, tombstones);

	if (db) {
		try {
			await initDb(db);
			await appendChangelog(db, safePath, 'delete', '', 0);
			await maybePruneChangelog(db);
		} catch (e) { /* D1 failure is non-fatal */ }
	}

	// Invalidate manifest cache instead of read-modify-write (fixes race condition)
	await invalidateManifestCache(bucket);

	return corsResponse({ success: true, path: safePath });
}

async function handleGetTombstones(bucket) {
	const tombstones = await getTombstones(bucket);
	const now = new Date();
	pruneTombstones(tombstones, now);
	return corsResponse(tombstones);
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
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

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
			if (path === '/sync/upload' && method === 'PUT') return await handleUpload(request, bucket, db);
			if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket);
			if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket, db);
			if (path === '/sync/tombstones' && method === 'GET') return await handleGetTombstones(bucket);
			if (path === '/sync/config' && method === 'GET') return await handleGetConfig(env);

			return corsResponse({ error: 'Not found' }, 404);
		} catch (err) {
			return corsResponse({ error: err.message || 'Internal server error' }, 500);
		}
	},
};
`;
}
