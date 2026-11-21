import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readLastBackup } from './local-server-backup.mjs';
import { startBackups } from './local-server-backup-schedule.mjs';
import { issueLocalDevice, listLocalDevices, readResetGeneration, revokeLocalDevice } from './local-server-runtime.mjs';

const hash = (/** @type {string} */ value) => createHash('sha256').update(value).digest('hex');
const codePattern = /^crate-pair-[a-f0-9]{64}$/;
// sun_path holds 104 bytes on macOS (108 on Linux), including the terminating NUL.
const socketPathLimit = 103;

/**
 * Single-use pairing codes, kept only in memory and only as hashes.
 * @param {object} options
 * @param {import('./local-server-runtime.mjs').LocalD1Database | (() => import('./local-server-runtime.mjs').LocalD1Database)} options.db
 * The database, or a getter for a runtime that a backup restarts.
 * @param {() => number} [options.now]
 * @param {number} [options.lifetime] Milliseconds a code stays valid.
 */
export function createPairing({ db, now = Date.now, lifetime = 10 * 60_000 }) {
	/** @type {Map<string, { name: string, expiresAt: number, resetGeneration: Promise<string | undefined> }>} */
	const codes = new Map();
	const database = () => typeof db === 'function' ? db() : db;
	return {
		issue(name = 'Obsidian device') {
			if (typeof name !== 'string' || !name.trim() || name.trim().length > 128) throw new Error('Provide a device name between 1 and 128 characters.');
			for (const [key, entry] of codes) if (entry.expiresAt <= now()) codes.delete(key);
			if (codes.size >= 20) throw new Error('Too many pending pairings. Wait for a code to expire before creating another.');
			const code = `crate-pair-${randomBytes(32).toString('hex')}`;
			// An encryption reset replaces every credential, so a code issued before it is void.
			const resetGeneration = readResetGeneration(database()).catch(() => undefined);
			const entry = { name: name.trim(), expiresAt: now() + lifetime, resetGeneration };
			codes.set(hash(code), entry);
			return { code, expiresAt: entry.expiresAt };
		},
		/** @param {unknown} code */
		async exchange(code) {
			if (typeof code !== 'string' || !codePattern.test(code)) return null;
			const key = hash(code);
			const entry = codes.get(key);
			// Claim synchronously before the first await: concurrent requests cannot
			// redeem a code twice. A failed exchange requires a fresh pairing code.
			codes.delete(key);
			if (!entry || entry.expiresAt <= now()) return null;
			const resetGeneration = await entry.resetGeneration;
			if (resetGeneration === undefined) return null;
			return issueLocalDevice(database(), entry.name, resetGeneration);
		},
	};
}

/** @typedef {ReturnType<typeof createPairing>} LocalPairing */

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} value */
export function sendJson(response, status, value) {
	response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(value));
}

/** @param {import('node:http').IncomingMessage} request @param {number} [limit] Maximum characters. */
export async function readSmallJson(request, limit = 2048) {
	let body = '';
	for await (const chunk of request) {
		body += chunk.toString();
		if (body.length > limit) throw new Error('Request too large');
	}
	return JSON.parse(body);
}

/** Administration stays on a private local socket and additionally requires a
 * random secret stored in the owner's private data directory. Never proxied.
 * @param {object} options
 * @param {string} options.dataDir
 * @param {Pick<LocalPairing, 'issue'>} options.pairing
 * @param {string} options.origin
 * @param {import('./local-server-runtime.mjs').LocalRuntime} options.runtime */
export async function startLocalControl({ dataDir, pairing, origin, runtime }) {
	const file = join(dataDir, 'control.json');
	const id = randomBytes(16).toString('hex');
	// Scheduled temp cleanup can delete a long-running server's socket, so prefer the
	// data directory and use the temp directory only when that path is too long.
	const inData = join(dataDir, 'control.sock');
	const socket = process.platform === 'win32' ? `\\\\.\\pipe\\crate-${id}`
		: Buffer.byteLength(inData) <= socketPathLimit ? inData : join(tmpdir(), `crate-${id}.sock`);
	// The caller holds the data directory lock, so a socket already there was left by a crash.
	if (socket === inData) await unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
	const secret = randomBytes(32).toString('hex');
	const backups = startBackups({ dataDir, runtime });
	/** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
	const withRuntime = async task => {
		const release = await runtime.request();
		if (!release) throw new Error('Crate is finishing a backup. Try again shortly.');
		try { return await task(); } finally { release(); }
	};
	const server = createServer(async (request, response) => {
		if (request.headers.authorization !== `Bearer ${secret}`) { sendJson(response, 403, { error: 'Not authorized' }); return; }
		if (request.method === 'GET' && request.url === '/devices') {
			try { sendJson(response, 200, { devices: await withRuntime(() => listLocalDevices(runtime.db)) }); }
			catch { sendJson(response, 500, { error: 'Could not list devices.' }); }
			return;
		}
		if (request.method === 'GET' && request.url === '/status') {
			sendJson(response, 200, { origin, uptimeSeconds: Math.round(process.uptime()), crashes: runtime.crashes,
				lastBackup: await readLastBackup(dataDir), autoBackup: await backups.status() });
			return;
		}
		if (request.method === 'POST' && request.url === '/revoke') {
			try {
				const { id } = await readSmallJson(request);
				sendJson(response, 200, { revoked: await withRuntime(() => revokeLocalDevice(runtime, id)) });
			} catch (error) { sendJson(response, 400, { error: error.message }); }
			return;
		}
		if (request.method === 'POST' && request.url === '/backup') {
			try {
				const { output } = await readSmallJson(request, 8192);
				if (typeof output !== 'string' || !isAbsolute(output)) throw new Error('Provide an absolute backup path.');
				sendJson(response, 200, await backups.run(output));
			} catch (error) { sendJson(response, error.code === 'EBUSY' ? 409 : 400, { error: error.message }); }
			return;
		}
		if (request.method === 'POST' && request.url === '/auto-backup') {
			void backups.check();
			sendJson(response, 200, { checking: true });
			return;
		}
		if (request.method !== 'POST' || request.url !== '/pair') { sendJson(response, 404, { error: 'Not found' }); return; }
		try {
			const { name } = await readSmallJson(request);
			sendJson(response, 200, { ...pairing.issue(name), origin });
		} catch { sendJson(response, 400, { error: 'Could not create a pairing code. Check the device name or wait for pending codes to expire.' }); }
	});
	server.requestTimeout = 5000;
	await /** @type {Promise<void>} */ (new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }));
	try {
		if (process.platform !== 'win32') await chmod(socket, 0o600);
		await writeFile(file, JSON.stringify({ socket, secret }), { mode: 0o600 });
		await chmod(file, 0o600);
	} catch (error) { server.close(); await backups.close(); throw error; }
	return { async close() {
		// A running backup holds the runtime paused; it finishes before storage closes.
		await backups.close();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
	} };
}

/** The running server's control socket and secret (`control.json`).
 * @typedef {{ socket: string, secret: string }} LocalControlFile */

/** Sends one request to the running server's private control socket. Rejects with
 * code ENOENT when no server is running for this data directory.
 * @param {string} dataDir @param {string} method @param {string} path @param {unknown} [body]
 * @param {number} [timeout] Milliseconds to wait for the server.
 * @returns {Promise<any>} The parsed JSON response. */
export async function requestLocalControl(dataDir, method, path, body, timeout = 5000) {
	/** @type {LocalControlFile} */
	const { socket, secret } = JSON.parse(await readFile(join(dataDir, 'control.json'), 'utf8'));
	return new Promise((resolve, reject) => {
		const request = httpRequest({ socketPath: socket, path, method,
			headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, timeout,
		}, async response => {
			try {
				const result = await readSmallJson(response, 1024 * 1024);
				if (response.statusCode !== 200) throw new Error(result.error);
				resolve(result);
			} catch (error) { reject(error); }
		});
		request.on('error', reject);
		request.on('timeout', () => request.destroy(new Error('Local administration timed out.')));
		request.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

/** @param {string} dataDir @param {string | undefined} name
 * @returns {Promise<{ code: string, expiresAt: number, origin: string }>} */
export async function requestLocalPairing(dataDir, name) {
	try { return await requestLocalControl(dataDir, 'POST', '/pair', { name }); }
	catch { throw new Error('Could not create a pairing code. Keep Crate running, check the data directory and device name, then try again.'); }
}
