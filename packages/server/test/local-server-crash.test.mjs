import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { openLocalRuntime } from '../src/local-server-runtime.mjs';

const cli = new URL('../../../scripts/local-server.mjs', import.meta.url).pathname;

/** @param {number} parent */
async function workerdChildren(parent) {
	const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
	return stdout.split('\n').flatMap(line => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		return match && Number(match[2]) === parent && match[3].trim().endsWith('workerd') ? [Number(match[1])] : [];
	});
}

/** @param {number} pid */
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function freePort() {
	const socket = createServer();
	await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
	const { port } = /** @type {import('node:net').AddressInfo} */ (socket.address());
	await new Promise(resolve => socket.close(resolve));
	return port;
}

/** @param {string} dataDir @param {number} port */
async function startServer(dataDir, port) {
	const child = spawn(process.execPath, [cli, 'start', '--data-dir', dataDir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
	const exited = once(child, 'exit');
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	const deadline = Date.now() + 20_000;
	while (!output.includes('Press Ctrl+C')) {
		if (child.exitCode !== null) return { child, exited, output, started: false };
		assert.ok(Date.now() < deadline, `CLI startup timed out: ${output}`);
		await delay(50);
	}
	return { child, exited, get output() { return output; }, started: true };
}

test('a server killed mid-write recovers its data and the next start stops the workerd it left running', { timeout: 120_000, skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-local-crash-'));
	/** @type {Awaited<ReturnType<typeof startServer>> | undefined} */
	let server;
	/** @type {number[]} */
	let orphans = [];
	try {
		const { stdout } = await promisify(execFile)(process.execPath, [cli, 'add-device', '--name', 'Crash test', '--data-dir', dataDir]);
		const token = /Access token \(shown once\): ([a-f0-9]{64})/.exec(stdout)?.[1];
		assert.ok(token);
		const setup = await openLocalRuntime({ dataDir, administrative: true });
		try { await setup.db.prepare("INSERT INTO server_state(id, import_token, import_state) VALUES (1, 'test', 'complete') ON CONFLICT(id) DO UPDATE SET import_token = excluded.import_token, import_state = excluded.import_state").run(); }
		finally { await setup.close(); }

		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		server = await startServer(dataDir, port);
		assert.ok(server.started, server.output);
		const info = await (await fetch(`${origin}/.well-known/crate`)).json();
		const headers = { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': String(info.protocol.current) };
		/** @type {Map<string, { operation: string, body: string, result?: unknown }>} */
		const uploads = new Map();
		const upload = async (/** @type {string} */ path) => {
			const entry = uploads.get(path) ?? { operation: `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${randomUUID()}`, body: `bytes of ${path} ${randomUUID()}` };
			uploads.set(path, entry);
			const response = await fetch(`${origin}/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: {
				...headers, 'Content-Type': 'text/plain', 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': entry.operation,
			}, body: entry.body });
			const text = await response.text();
			if (response.status !== 200) throw new Error(`${response.status} ${text}`);
			return JSON.parse(text);
		};
		/** Uploads `paths` concurrently and returns once `after` of them settled, leaving the rest in flight. */
		const uploadDuring = async (/** @type {string[]} */ paths, /** @type {number} */ after) => {
			let settled = 0;
			const all = paths.map(path => upload(path).then(result => { /** @type {{ result?: unknown }} */ (uploads.get(path)).result = result; }, () => {})
				.finally(() => { settled++; }));
			while (settled < after) await delay(5);
			return Promise.all(all);
		};

		// Case A: workerd dies. Miniflare restarts it and the same process serves again.
		const [workerd] = await workerdChildren(/** @type {number} */ (server.child.pid));
		assert.ok(workerd, 'The server runs workerd as its child');
		const first = uploadDuring(Array.from({ length: 20 }, (_, index) => `a/${index}.md`), 3);
		process.kill(workerd, 'SIGKILL');
		await first;
		const deadline = Date.now() + 20_000;
		while (!(await fetch(`${origin}/.well-known/crate`).then(response => response.ok, () => false))) {
			assert.ok(Date.now() < deadline, 'The runtime did not come back after workerd was killed');
			await delay(100);
		}
		assert.equal(server.child.exitCode, null);
		const status = async () => (await promisify(execFile)(process.execPath, [cli, 'status', '--data-dir', dataDir]).catch(error => error)).stdout;
		assert.match(await status(), /Status: running.*\nRuntime crashes recovered: 1\nLast backup: none recorded/s);

		// Case B: the server process dies mid-write. Its workerd keeps running on the same files.
		[orphans[0]] = await workerdChildren(/** @type {number} */ (server.child.pid));
		const second = uploadDuring(Array.from({ length: 20 }, (_, index) => `b/${index}.md`), 3);
		server.child.kill('SIGKILL');
		await server.exited;
		await second;
		await delay(500);
		assert.ok(running(orphans[0]), 'workerd outlives a killed server process');
		assert.match(await status(), /Status: not responding/);
		// No reboot, no manual kill and no lock removal: the next start stops the workerd
		// the dead server recorded (the one Miniflare restarted in case A) and reclaims the lock.
		server = await startServer(dataDir, port);
		assert.ok(server.started, server.output);
		assert.match(server.output, new RegExp(`Stopped workerd left running by a force-quit Crate server \\(PID ${orphans[0]}\\)`));
		assert.equal(running(orphans[0]), false);
		orphans = [];
		for (const [path, entry] of uploads) {
			// Resending an interrupted or completed upload either commits it once or replays its receipt.
			const result = await upload(path);
			if (entry.result !== undefined) assert.deepEqual(result, entry.result, `${path} must replay its receipt`);
			const response = await fetch(`${origin}/sync/download?path=${encodeURIComponent(path)}`, { headers });
			assert.equal(response.status, 200, path);
			assert.equal(await response.text(), entry.body, `${path} must keep its committed bytes`);
		}
		server.child.kill('SIGTERM');
		const [code] = await server.exited;
		assert.equal(code, 0, server.output);
		server = undefined;

		const check = await openLocalRuntime({ dataDir, administrative: true });
		try {
			assert.deepEqual((await check.db.prepare('PRAGMA quick_check').all()).results.map(row => Object.values(row)[0]), ['ok']);
			assert.equal((await check.db.prepare('SELECT COUNT(*) AS count FROM files').first()).count, uploads.size);
		} finally { await check.close(); }
	} finally {
		// Killing the server alone would orphan its workerd.
		if (server?.child.exitCode === null) {
			orphans.push(...await workerdChildren(/** @type {number} */ (server.child.pid)));
			server.child.kill('SIGKILL');
		}
		for (const pid of orphans) if (running(pid)) process.kill(pid, 'SIGKILL');
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('another server\'s leftover workerd does not stop a force-quit server from starting again', { timeout: 120_000, skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-local-crash-'));
	const otherDir = await mkdtemp(join(tmpdir(), 'crate-local-crash-other-'));
	/** @type {Awaited<ReturnType<typeof startServer>> | undefined} */
	let server;
	/** @type {number[]} */
	const others = [];
	/** @type {number[]} */
	let own = [];
	try {
		// Another server is force-quit and leaves its workerd running on its own data.
		const other = await startServer(otherDir, await freePort());
		assert.ok(other.started, other.output);
		others.push(...await workerdChildren(/** @type {number} */ (other.child.pid)));
		assert.ok(others.length, 'The other server runs workerd as its child');
		other.child.kill('SIGKILL');
		await other.exited;
		await delay(500);
		assert.ok(others.every(running), 'workerd outlives the other killed server');

		const port = await freePort();
		server = await startServer(dataDir, port);
		assert.ok(server.started, server.output);
		own = await workerdChildren(/** @type {number} */ (server.child.pid));
		server.child.kill('SIGKILL');
		await server.exited;
		await delay(500);
		server = await startServer(dataDir, port);
		assert.ok(server.started, server.output);
		assert.ok(own.every(pid => !running(pid)), 'The start stops the workerd its own data directory left running');
		assert.ok(others.every(running), 'The start leaves the other server\'s workerd alone');
		server.child.kill('SIGTERM');
		const [code] = await server.exited;
		assert.equal(code, 0, server.output);
		server = undefined;
	} finally {
		if (server?.child.exitCode === null) {
			own.push(...await workerdChildren(/** @type {number} */ (server.child.pid)));
			server.child.kill('SIGKILL');
		}
		for (const pid of [...own, ...others]) if (running(pid)) process.kill(pid, 'SIGKILL');
		await rm(dataDir, { recursive: true, force: true });
		await rm(otherDir, { recursive: true, force: true });
	}
});
