import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readSmallJson, sendJson } from './local-server-pairing.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The header each managed tunnel sets to the client's address, replacing any value
// the client sent. Each passes the other's header through, so trust only its own.
// Tailscale serve and Funnel drop inbound X-Forwarded-* and set X-Forwarded-For to
// the single source address.
/** @typedef {'cloudflare' | 'tailscale'} ManagedTunnel */
/** @type {Record<ManagedTunnel, string>} */
const FORWARDED_ADDRESS = { cloudflare: 'cf-connecting-ip', tailscale: 'x-forwarded-for' };

/** A managed tunnel ('cloudflare' or 'tailscale') connects from loopback and forwards
 * each client's address, so per-address admission limits stay per client.
 * @param {import('node:http').IncomingMessage} request
 * @param {ManagedTunnel | null} [tunnel] */
export function clientAddress(request, tunnel) {
	const peer = request.socket.remoteAddress ?? '127.0.0.1';
	const forwarded = tunnel ? request.headers[FORWARDED_ADDRESS[tunnel]] : undefined;
	return LOOPBACK.has(peer) && typeof forwarded === 'string' && forwarded ? forwarded : peer;
}

// Expose only the application fetch handler. Miniflare's development HTTP
// endpoints and inspector stay on their own private loopback listener.
/**
 * @param {import('./local-server-runtime.mjs').LocalRuntime | (() => import('./local-server-runtime.mjs').LocalRuntime | null | undefined)} runtime
 * The runtime, or a getter that returns none while the server starts.
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {{ exchange(code: unknown): Promise<{ token: string } | null> }} [options.pairing]
 * @param {string} [options.instance] Answers the public readiness probe.
 * @param {ManagedTunnel | null} [options.tunnel]
 * @param {number} [options.maxFileBytes] Lengthens the request timeout for larger uploads.
 */
export async function listenLocalServer(runtime, { host = '127.0.0.1', port = 8787, pairing, instance, tunnel = null, maxFileBytes = 0 } = {}) {
	const server = createServer(async (request, response) => {
		try {
			const active = typeof runtime === 'function' ? runtime() : runtime;
			if (!active) {
				response.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
				response.end('Crate is starting.');
				return;
			}
			const url = new URL(request.url || '/', active.origin);
			if (url.origin !== active.origin || /^\/(?:cdn-cgi|__cf_local)(?:\/|$)/.test(decodeURIComponent(url.pathname))) {
				response.writeHead(404);
				response.end();
				return;
			}
			if (url.pathname === '/__crate/ready' && request.method === 'GET' && instance) {
				sendJson(response, 200, { instance }); return;
			}
			// A backup pauses the runtime briefly; hold the request until it resumes.
			const release = await active.request();
			if (!release) {
				response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '5' });
				response.end(JSON.stringify({ error: 'Crate is finishing a backup. Try again shortly.' }));
				return;
			}
			try {
				if (url.pathname === '/__crate/pair' && pairing) {
					if (request.method !== 'POST') { sendJson(response, 405, { error: 'Use POST' }); return; }
					let credential;
					try { credential = await pairing.exchange((await readSmallJson(request)).code); }
					catch { sendJson(response, 400, { error: 'Could not redeem this pairing code. Generate a new code and try again.' }); return; }
					if (!credential) { sendJson(response, 401, { error: 'Pairing code expired or already used. Generate a new code on your server.' }); return; }
					sendJson(response, 200, { authToken: credential.token }); return;
				}
				const headers = new Headers();
				for (const [name, value] of Object.entries(request.headers)) {
					if (value !== undefined && !['host', 'connection', 'transfer-encoding'].includes(name)
						&& !name.startsWith('mf-') && !name.startsWith('cf-') && !name.startsWith('x-forwarded-') && !name.startsWith('x-crate-internal-')) {
						headers.set(name, Array.isArray(value) ? value.join(', ') : value);
					}
				}
				headers.set('CF-Connecting-IP', clientAddress(request, tunnel));
				const abort = new AbortController();
				response.on('close', () => { if (!response.writableFinished) abort.abort(); });
				const result = await active.mf.dispatchFetch(url.href, {
					method: request.method, headers, redirect: 'manual', signal: abort.signal,
					...(['GET', 'HEAD'].includes(/** @type {string} */ (request.method)) ? {} : { body: Readable.toWeb(request), duplex: 'half' }),
				});
				const responseHeaders = new Headers(result.headers);
				// dispatchFetch transparently decodes upstream compression.
				if (responseHeaders.has('MF-Content-Encoding')) responseHeaders.delete('Content-Length');
				for (const name of ['MF-Content-Encoding', 'Content-Encoding', 'Transfer-Encoding', 'Connection']) responseHeaders.delete(name);
				response.writeHead(result.status, Object.fromEntries(responseHeaders));
				if (result.body) await pipeline(Readable.fromWeb(result.body), response);
				else response.end();
			} finally { release(); }
		} catch {
			if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'Local server unavailable' }));
		}
	});
	// Two minutes, or long enough to receive the largest single request at 256 KiB/s. Larger
	// files travel in parts; 128 MiB mirrors MAX_BUFFERED_FILE_BYTES in src/protocol/sync-limits.ts.
	server.requestTimeout = Math.max(120_000, Math.ceil(Math.min(maxFileBytes, 128 * 1024 * 1024) / (256 * 1024)) * 1000);
	await /** @type {Promise<void>} */ (new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }));
	return server;
}
