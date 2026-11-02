// @ts-check
// An ephemeral helper for terminal deletion. It never reads application data.
/** @typedef {{ BUCKET: Pick<R2Bucket, 'delete'>, CRATE_RESET_ID: string, CRATE_DELETE_TOKEN_HASH: string, CRATE_DELETE_UPLOAD_TAG: string }} DeleteEnv */
const headers = { 'Cache-Control': 'no-store' };

/** @param {string} text */
async function hash(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {Request} request */
async function readKeys(request) {
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
	if (!Array.isArray(keys) || !keys.length || keys.length > 1000 || new Set(keys).size !== keys.length
		|| keys.some(key => typeof key !== 'string' || !key || new TextEncoder().encode(key).length > 1024)) throw new Error('Invalid batch');
	return /** @type {string[]} */ (keys);
}

export default {
	/** @param {Request} request @param {DeleteEnv} env */
	async fetch(request, env) {
		const path = new URL(request.url).pathname;
		if (path === '/.well-known/crate-reset' && request.method === 'GET') {
			return Response.json({ service: 'crate-reset', protocol: 1, resetId: env.CRATE_RESET_ID, recoveryObjects: true, deleteAll: true,
				uploadTag: env.CRATE_DELETE_UPLOAD_TAG }, { headers });
		}
		if (path !== '/__crate__/reset/objects' || request.method !== 'POST') return new Response('Crate server deletion in progress', { status: 503, headers });
		const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
		if (!token || await hash(token) !== env.CRATE_DELETE_TOKEN_HASH) return new Response('Unauthorized', { status: 401, headers });
		let keys;
		try { keys = await readKeys(request); }
		catch { return new Response('Invalid cleanup batch', { status: 400, headers }); }
		try {
			// The user authorized removal of this entire bucket, including unknown
			// formats. R2 keys are opaque strings, not filesystem paths.
			await env.BUCKET.delete(keys);
			return Response.json({ service: 'crate-reset', protocol: 1, resetId: env.CRATE_RESET_ID,
				batchHash: await hash(JSON.stringify(keys)), deleted: keys.length }, { headers });
		} catch { return new Response('Cleanup outcome could not be confirmed', { status: 503, headers }); }
	},
	scheduled() {},
};
