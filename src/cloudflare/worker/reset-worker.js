// @ts-check
// Embedded verbatim in the retirement Worker. Keep this module self-contained.
/** @typedef {{ DB: D1Database, BUCKET: Pick<R2Bucket, 'delete'>, CRATE_RESET_ID: string }} ResetEnv */
const fenceKey = 'crate_deployment_fence';
const managedObject = /^__crate__\/files\/[a-f0-9]{64}\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const headers = { 'Cache-Control': 'no-store' };

/** @param {D1Database} db */
async function readFence(db) {
	const row = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(fenceKey).first();
	return typeof row?.value === 'string' ? row.value : null;
}

/** @param {string} text */
async function hash(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {Request} request */
async function readKeys(request) {
	// Enforce the actual byte limit even if Content-Length is missing or false.
	const reader = request.body?.getReader();
	if (!reader) throw new Error('Missing body');
	const decoder = new TextDecoder();
	let size = 0, text = '';
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 1_100_000) throw new Error('Batch too large');
			text += decoder.decode(part.value, { stream: true });
		}
		text += decoder.decode();
	} finally { await reader.cancel(); }
	/** @type {unknown} */
	const keys = JSON.parse(text);
	if (!Array.isArray(keys) || keys.length < 1 || keys.length > 1000 || new Set(keys).size !== keys.length
		|| keys.some(key => typeof key !== 'string' || !key || new TextEncoder().encode(key).length > 1024
			|| key.split('/').some(segment => segment === '.' || segment === '..'))) throw new Error('Invalid batch');
	return /** @type {string[]} */ (keys);
}

/** Verify every key before issuing the single R2 delete, including old referenced keys.
 * @param {D1Database} db
 * @param {string[]} keys
 */
async function ownsObjects(db, keys) {
	const pending = new Set(keys.filter(key => !managedObject.test(key) && key !== '__crate__/settings.json'));
	if (!pending.size) return true;
	for (const table of ['files', 'file_versions', 'object_cleanup_queue']) {
		const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
		const columns = results.map(row => row.name);
		const column = columns.includes('storage_key') ? 'storage_key' : table === 'files' && columns.includes('path') ? 'path' : null;
		if (!column) continue;
		const remaining = [...pending];
		for (let start = 0; start < remaining.length; start += 100) {
			const chunk = remaining.slice(start, start + 100);
			const found = await db.prepare(`SELECT ${column} AS key FROM ${table} WHERE ${column} IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
			for (const row of found.results) if (typeof row.key === 'string') pending.delete(row.key);
		}
		if (!pending.size) return true;
	}
	return false;
}

export default {
	/** @param {Request} request @param {ResetEnv} env */
	async fetch(request, env) {
		const path = new URL(request.url).pathname;
		if (path === '/.well-known/crate-reset' && request.method === 'GET') {
			return Response.json({ service: 'crate-reset', protocol: 1, resetId: env.CRATE_RESET_ID }, { headers });
		}
		if (path !== '/__crate__/reset/objects' || request.method !== 'POST') {
			return new Response('Crate server reset in progress', { status: 503, headers });
		}
		const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
		if (!token) return new Response('Unauthorized', { status: 401, headers });
		try {
			const current = await readFence(env.DB);
			if (typeof current !== 'string') return new Response('Cleanup not active', { status: 409, headers });
			const record = JSON.parse(current);
			if (record.cleanupTokenHash !== await hash(token)) return new Response('Unauthorized', { status: 401, headers });
			if (!['reset', 'delete'].includes(record.kind) || record.resetId !== env.CRATE_RESET_ID || record.recoveryProtocol !== 1
				|| record.step !== 'deleteR2Objects' || record.stepState !== 'started' || record.verificationPending === true) {
				return new Response('Cleanup ownership changed', { status: 409, headers });
			}
			let keys;
			try { keys = await readKeys(request); }
			catch { return new Response('Invalid cleanup batch', { status: 400, headers }); }
			const batchHash = await hash(JSON.stringify(keys));
			if (batchHash !== record.batchHash) return new Response('Batch not authorized', { status: 403, headers });
			if (!await ownsObjects(env.DB, keys)) return new Response('Unrecognized object', { status: 403, headers });
			// Recheck after validation. A resumed deletion revokes the previous token.
			if (await readFence(env.DB) !== current) {
				return new Response('Cleanup ownership changed', { status: 409, headers });
			}
			await env.BUCKET.delete(keys);
			return Response.json({ service: 'crate-reset', protocol: 1, resetId: env.CRATE_RESET_ID, batchHash, deleted: keys.length }, { headers });
		} catch {
			// Never return a definite rejection after a potentially dispatched delete.
			return new Response('Cleanup outcome could not be confirmed', { status: 503, headers });
		}
	},
	scheduled() {},
};
