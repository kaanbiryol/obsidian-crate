import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueLocalDevice } from './local-server-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const codePattern = /^crate-pair-[a-f0-9]{64}$/;

export function createPairing({ db, now = Date.now, lifetime = 10 * 60_000 }) {
	const codes = new Map();
	return {
		issue(name = 'Obsidian device') {
			if (typeof name !== 'string' || !name.trim() || name.trim().length > 128) throw new Error('Provide a device name between 1 and 128 characters.');
			for (const [key, entry] of codes) if (entry.expiresAt <= now()) codes.delete(key);
			if (codes.size >= 20) throw new Error('Too many pending pairings. Wait for a code to expire before creating another.');
			const code = `crate-pair-${randomBytes(32).toString('hex')}`;
			const entry = { name: name.trim(), expiresAt: now() + lifetime };
			codes.set(hash(code), entry);
			return { code, expiresAt: entry.expiresAt };
		},
		async exchange(code) {
			if (typeof code !== 'string' || !codePattern.test(code)) return null;
			const key = hash(code);
			const entry = codes.get(key);
			// Claim synchronously before the first await: concurrent requests cannot
			// redeem a code twice. A failed exchange requires a fresh pairing code.
			codes.delete(key);
			if (!entry || entry.expiresAt <= now()) return null;
			return issueLocalDevice(db, entry.name);
		},
	};
}

export function sendJson(response, status, value) {
	response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(value));
}

export async function readSmallJson(request) {
	let body = '';
	for await (const chunk of request) {
		body += chunk.toString();
		if (body.length > 2048) throw new Error('Request too large');
	}
	return JSON.parse(body);
}

/** Administration stays on a private local socket and additionally requires a
 * random secret stored in the owner's private data directory. Never proxied. */
export async function startLocalControl({ dataDir, pairing, origin }) {
	const file = join(dataDir, 'control.json');
	const id = randomBytes(16).toString('hex');
	const socket = process.platform === 'win32' ? `\\\\.\\pipe\\crate-${id}` : join(tmpdir(), `crate-${id}.sock`);
	const secret = randomBytes(32).toString('hex');
	const server = createServer(async (request, response) => {
		if (request.headers.authorization !== `Bearer ${secret}`) { sendJson(response, 403, { error: 'Not authorized' }); return; }
		if (request.method !== 'POST' || request.url !== '/pair') { sendJson(response, 404, { error: 'Not found' }); return; }
		try {
			const { name } = await readSmallJson(request);
			sendJson(response, 200, { ...pairing.issue(name), origin });
		} catch { sendJson(response, 400, { error: 'Could not create a pairing code. Check the device name or wait for pending codes to expire.' }); }
	});
	server.requestTimeout = 5000;
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
	try {
		if (process.platform !== 'win32') await chmod(socket, 0o600);
		await writeFile(file, JSON.stringify({ socket, secret }), { mode: 0o600 });
		await chmod(file, 0o600);
	} catch (error) { server.close(); throw error; }
	return { async close() {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
	} };
}

export async function requestLocalPairing(dataDir, name) {
	try {
		const { socket, secret } = JSON.parse(await readFile(join(dataDir, 'control.json'), 'utf8'));
		return await new Promise((resolve, reject) => {
			const request = httpRequest({ socketPath: socket, path: '/pair', method: 'POST',
				headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, timeout: 5000,
			}, async response => {
				try {
					const body = await readSmallJson(response);
					if (response.statusCode !== 200) throw new Error(body.error);
					resolve(body);
				} catch (error) { reject(error); }
			});
			request.on('error', reject);
			request.on('timeout', () => request.destroy(new Error('Local administration timed out.')));
			request.end(JSON.stringify({ name }));
		});
	} catch { throw new Error('Could not create a pairing code. Keep Crate running, check the data directory and device name, then try again.'); }
}
