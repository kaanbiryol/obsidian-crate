/**
 * Worker script template that gets deployed to Cloudflare
 * This is bundled into the CLI and deployed during `crate init`
 * Uses native Workers API (no external dependencies)
 */

export function getWorkerScript(): string {
	return `
const MANIFEST_KEY = '.crate/manifest.json';
const TOMBSTONES_KEY = '.crate/tombstones.json';
const FILES_PREFIX = 'files/';
const TOMBSTONE_TTL_DAYS = 30;

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

async function getManifest(bucket) {
	const obj = await bucket.get(MANIFEST_KEY);
	if (!obj) return { version: 1, files: {} };
	return await obj.json();
}

async function putManifest(bucket, manifest) {
	await bucket.put(MANIFEST_KEY, JSON.stringify(manifest), {
		httpMetadata: { contentType: 'application/json' },
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

async function handleGetManifest(bucket) {
	const manifest = await getManifest(bucket);
	return corsResponse(manifest);
}

async function handleUpload(request, bucket) {
	const body = await request.json();

	if (!body.files || !Array.isArray(body.files)) {
		return corsResponse({ error: 'Invalid request: files array required' }, 400);
	}

	const manifest = await getManifest(bucket);
	const results = [];

	for (const file of body.files) {
		if (!file.path || file.content === undefined) {
			results.push({ path: file.path, error: 'Missing path or content' });
			continue;
		}

		try {
			const content = file.binary
				? Uint8Array.from(atob(file.content), c => c.charCodeAt(0))
				: file.content;

			await bucket.put(FILES_PREFIX + file.path, content, {
				httpMetadata: {
					contentType: file.contentType || 'text/plain',
				},
			});

			manifest.files[file.path] = {
				hash: file.hash,
				size: file.size,
				modified: new Date().toISOString(),
			};

			results.push({ path: file.path, success: true });
		} catch (err) {
			results.push({ path: file.path, error: err.message });
		}
	}

	await putManifest(bucket, manifest);
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

async function handleDelete(request, bucket) {
	const body = await request.json();

	if (!body.path) {
		return corsResponse({ error: 'Path required' }, 400);
	}

	await bucket.delete(FILES_PREFIX + body.path);

	const manifest = await getManifest(bucket);
	delete manifest.files[body.path];
	await putManifest(bucket, manifest);

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

		try {
			if (path === '/health' && method === 'GET') return await handleHealth();
			if (path === '/sync/manifest' && method === 'GET') return await handleGetManifest(bucket);
			if (path === '/sync/upload' && method === 'POST') return await handleUpload(request, bucket);
			if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket);
			if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket);
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
