import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readSmallJson, sendJson } from './local-server-pairing.mjs';

// Expose only the application fetch handler. Miniflare's development HTTP
// endpoints and inspector stay on their own private loopback listener.
export async function listenLocalServer(runtime, { host = '127.0.0.1', port = 8787, pairing, instance } = {}) {
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
			headers.set('CF-Connecting-IP', request.socket.remoteAddress ?? '127.0.0.1');
			const abort = new AbortController();
			response.on('close', () => { if (!response.writableFinished) abort.abort(); });
			const result = await active.mf.dispatchFetch(url.href, {
				method: request.method, headers, redirect: 'manual', signal: abort.signal,
				...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Readable.toWeb(request), duplex: 'half' }),
			});
			const responseHeaders = new Headers(result.headers);
			// dispatchFetch transparently decodes upstream compression.
			if (responseHeaders.has('MF-Content-Encoding')) responseHeaders.delete('Content-Length');
			for (const name of ['MF-Content-Encoding', 'Content-Encoding', 'Transfer-Encoding', 'Connection']) responseHeaders.delete(name);
			response.writeHead(result.status, Object.fromEntries(responseHeaders));
			if (result.body) await pipeline(Readable.fromWeb(result.body), response);
			else response.end();
		} catch {
			if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'Local server unavailable' }));
		}
	});
	server.requestTimeout = 120_000;
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
	return server;
}
