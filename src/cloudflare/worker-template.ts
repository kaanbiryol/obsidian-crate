/**
 * Worker script template deployed by in-plugin setup and deploy actions.
 * Kept in sync with the CLI template.
 */

export function getWorkerScript(): string {
	return `
const FILES_PREFIX = 'files/';
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

async function timingSafeEqual(a, b) {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.byteLength !== bBytes.byteLength) {
		// Compare a against itself to keep constant time, then return false
		await crypto.subtle.timingSafeEqual(aBytes, aBytes);
		return false;
	}
	return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

async function initDb(db) {
	if (dbReady) return;
	await db.prepare(\`CREATE TABLE IF NOT EXISTS changelog (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		path TEXT NOT NULL,
		action TEXT NOT NULL,
		hash TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)\`).run();
	await db.prepare(\`CREATE TABLE IF NOT EXISTS files (
		path TEXT PRIMARY KEY,
		hash TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		modified TEXT NOT NULL DEFAULT (datetime('now'))
	)\`).run();
	dbReady = true;
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

async function compressedCorsResponse(body, request, status = 200) {
	const json = JSON.stringify(body);
	return new Response(json, {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeaders() },
	});
}

async function handleHealth() {
	return corsResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

async function queryRows(statement) {
	const result = await statement.all();
	return Array.isArray(result && result.results) ? result.results : [];
}

async function handleCheckChanges(request, db) {
	if (!db) return corsResponse({ error: 'Changelog not available' }, 404);
	await initDb(db);
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);
	const maxRows = await queryRows(db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'));
	const minRows = await queryRows(db.prepare('SELECT MIN(seq) as minSeq FROM changelog'));
	const lastSeq = (maxRows[0] && maxRows[0].lastSeq) || 0;
	const minSeq = minRows[0] ? minRows[0].minSeq : null;
	const cursorExpired = since > 0 && (minSeq === null || since < minSeq);
	return corsResponse({ lastSeq, hasChanges: lastSeq > since, ...(cursorExpired && { cursorExpired: true }) });
}

async function handleGetChanges(request, db) {
	if (!db) return corsResponse({ error: 'Changelog not available' }, 404);

	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);

	await initDb(db);
	const changeRows = await queryRows(
		db.prepare('SELECT seq, path, action, hash, size, created_at FROM changelog WHERE seq > ? ORDER BY seq ASC LIMIT 5000').bind(since)
	);
	const maxRows = await queryRows(db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'));
	const minRows = await queryRows(db.prepare('SELECT MIN(seq) as minSeq FROM changelog'));
	const lastSeq = (maxRows[0] && maxRows[0].lastSeq) || 0;
	const minSeq = minRows[0] ? minRows[0].minSeq : null;
	const cursorExpired = since > 0 && (minSeq === null || since < minSeq);

	return corsResponse({
		changes: changeRows,
		lastSeq,
		hasMore: changeRows.length === 5000,
		...(cursorExpired && { cursorExpired: true }),
	});
}

async function handleGetManifest(request, db) {
	if (!db) return corsResponse({ error: 'Database not available' }, 404);
	await initDb(db);

	const MAX_MANIFEST_FILES = 200000;
	const filesRows = await queryRows(
		db.prepare('SELECT path, hash, size, modified FROM files LIMIT 200001')
	);
	const seqRows = await queryRows(db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'));
	const truncated = filesRows.length > MAX_MANIFEST_FILES;
	const rows = truncated ? filesRows.slice(0, MAX_MANIFEST_FILES) : filesRows;
	const files = {};
	for (const row of rows) {
		files[row.path] = { hash: row.hash, size: row.size, modified: row.modified };
	}
	const lastSeq = (seqRows[0] && seqRows[0].lastSeq) || 0;

	return compressedCorsResponse({ version: 1, files, lastSeq, ...(truncated && { truncated: true }) }, request);
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
		// Stream request body directly to R2 - zero memory buffering
		await bucket.put(FILES_PREFIX + safePath, request.body, {
			httpMetadata: { contentType },
			customMetadata: { hash },
		});

		if (db) {
			try {
				await initDb(db);
				await db.batch([
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'put', hash || '', size || 0),
					db.prepare('INSERT OR REPLACE INTO files (path, hash, size, modified) VALUES (?, ?, ?, datetime(\\'now\\'))').bind(safePath, hash || '', size || 0),
				]);
				await maybePruneChangelog(db);
			} catch (e) { /* D1 failure is non-fatal */ }
		}

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

	if (db) {
		try {
			await initDb(db);
			await db.batch([
				db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'delete', '', 0),
				db.prepare('DELETE FROM files WHERE path = ?').bind(safePath),
			]);
			await maybePruneChangelog(db);
		} catch (e) { /* D1 failure is non-fatal */ }
	}

	return corsResponse({ success: true, path: safePath });
}

async function handleBatchUpload(request, bucket, db) {
	const body = await request.json();
	const files = body.files;
	if (!Array.isArray(files) || files.length === 0) {
		return corsResponse({ error: 'files array required' }, 400);
	}
	if (files.length > 50) {
		return corsResponse({ error: 'Maximum 50 files per batch' }, 400);
	}

	let totalBytes = 0;
	for (const f of files) {
		totalBytes += f.size || 0;
	}
	if (totalBytes > 10 * 1024 * 1024) {
		return corsResponse({ error: 'Total content exceeds 10MB limit' }, 400);
	}

	const results = [];
	const dbOps = [];

	await Promise.all(files.map(async (file) => {
		const safePath = sanitizePath(file.path);
		if (!safePath) {
			results.push({ path: file.path, success: false, error: 'Invalid path' });
			return;
		}

		try {
			const raw = atob(file.content);
			const bytes = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

			await bucket.put(FILES_PREFIX + safePath, bytes.buffer, {
				httpMetadata: { contentType: file.contentType || 'application/octet-stream' },
				customMetadata: { hash: file.hash || '' },
			});

			results.push({ path: safePath, success: true, hash: file.hash || '' });

			if (db) {
				dbOps.push(
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'put', file.hash || '', file.size || 0),
					db.prepare('INSERT OR REPLACE INTO files (path, hash, size, modified) VALUES (?, ?, ?, datetime(\\'now\\'))').bind(safePath, file.hash || '', file.size || 0),
				);
			}
		} catch (err) {
			results.push({ path: safePath, success: false, error: err.message || String(err) });
		}
	}));

	if (db && dbOps.length > 0) {
		try {
			await initDb(db);
			await db.batch(dbOps);
			await maybePruneChangelog(db);
		} catch (e) { /* D1 failure is non-fatal */ }
	}

	return corsResponse({ success: results.every(r => r.success), results });
}

async function handleBatchDownload(request, bucket) {
	const body = await request.json();
	const paths = body.paths;
	if (!Array.isArray(paths) || paths.length === 0) {
		return corsResponse({ error: 'paths array required' }, 400);
	}
	if (paths.length > 50) {
		return corsResponse({ error: 'Maximum 50 files per batch' }, 400);
	}

	const files = [];
	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			files.push({ path: rawPath, content: '', hash: '', size: 0, contentType: '', error: 'Invalid path' });
			continue;
		}

		try {
			const obj = await bucket.get(FILES_PREFIX + safePath);
			if (!obj) {
				files.push({ path: safePath, content: '', hash: '', size: 0, contentType: '', error: 'File not found' });
				continue;
			}

			const arrayBuffer = await obj.arrayBuffer();
			const bytes = new Uint8Array(arrayBuffer);
			const chunkSize = 8192;
			let binary = '';
			for (let i = 0; i < bytes.length; i += chunkSize) {
				const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
				binary += String.fromCharCode(...chunk);
			}
			const b64 = btoa(binary);

			files.push({
				path: safePath,
				content: b64,
				hash: obj.customMetadata?.hash || '',
				size: obj.size,
				contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
			});
		} catch (err) {
			files.push({ path: safePath, content: '', hash: '', size: 0, contentType: '', error: err.message || String(err) });
		}
	}

	return corsResponse({ files });
}

async function handleBatchDelete(request, bucket, db) {
	const body = await request.json();
	const paths = body.paths;
	if (!Array.isArray(paths) || paths.length === 0) {
		return corsResponse({ error: 'paths array required' }, 400);
	}
	if (paths.length > 50) {
		return corsResponse({ error: 'Maximum 50 files per batch' }, 400);
	}

	const deleted = [];
	const dbOps = [];

	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) continue;

		try {
			await bucket.delete(FILES_PREFIX + safePath);
			deleted.push(safePath);

			if (db) {
				dbOps.push(
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'delete', '', 0),
					db.prepare('DELETE FROM files WHERE path = ?').bind(safePath),
				);
			}
		} catch (e) { /* skip failed deletes */ }
	}

	if (db && dbOps.length > 0) {
		try {
			await initDb(db);
			await db.batch(dbOps);
			await maybePruneChangelog(db);
		} catch (e) { /* D1 failure is non-fatal */ }
	}

	return corsResponse({ success: true, deleted });
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
		if (!await timingSafeEqual(token, env.AUTH_TOKEN)) {
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
			if (path === '/sync/manifest' && method === 'GET') return await handleGetManifest(request, db);
			if (path === '/sync/upload' && method === 'PUT') return await handleUpload(request, bucket, db);
			if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket);
			if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket, db);
			if (path === '/sync/batch-upload' && method === 'POST') return await handleBatchUpload(request, bucket, db);
			if (path === '/sync/batch-download' && method === 'POST') return await handleBatchDownload(request, bucket);
			if (path === '/sync/batch-delete' && method === 'POST') return await handleBatchDelete(request, bucket, db);
			if (path === '/sync/config' && method === 'GET') return await handleGetConfig(env);

			return corsResponse({ error: 'Not found' }, 404);
		} catch (err) {
			return corsResponse({ error: err.message || 'Internal server error' }, 500);
		}
	},
};
`;
}
