import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { backupLocalServer, restoreLocalServer } from '../src/local-server-backup.mjs';
import { automaticBackupName, listAutomaticBackups, saveAutoBackup, startBackups } from '../src/local-server-backup-schedule.mjs';
import { listenLocalServer } from '../src/local-server-http.mjs';
import { createRequestGate, openLocalRuntime } from '../src/local-server-runtime.mjs';

const cli = new URL('../../../scripts/local-server.mjs', import.meta.url).pathname;
const run = promisify(execFile);

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
		assert.equal(child.exitCode, null, output);
		assert.ok(Date.now() < deadline, `CLI startup timed out: ${output}`);
		await delay(50);
	}
	return { child, exited, get output() { return output; } };
}

/** A device token on a server whose initial import is complete. @param {string} dataDir */
async function prepareServer(dataDir) {
	const { stdout } = await run(process.execPath, [cli, 'add-device', '--name', 'Backup test', '--data-dir', dataDir]);
	const token = /Access token \(shown once\): ([a-f0-9]{64})/.exec(stdout)?.[1];
	assert.ok(token);
	const setup = await openLocalRuntime({ dataDir, administrative: true });
	try { await setup.db.prepare("INSERT INTO server_state(id, import_token, import_state) VALUES (1, 'test', 'complete') ON CONFLICT(id) DO UPDATE SET import_token = excluded.import_token, import_state = excluded.import_state").run(); }
	finally { await setup.close(); }
	return token;
}

test('the request gate holds new requests while closed and waits for running ones', async () => {
	const gate = createRequestGate({ hold: 200, drain: 1000 });
	const running = await gate.request();
	assert.ok(running);
	let closed = false;
	const closing = gate.close().then(() => { closed = true; });
	await delay(20);
	assert.equal(closed, false, 'closing waits for the running request');
	running();
	await closing;
	let admitted = false;
	const held = gate.request().then(release => { admitted = true; return release; });
	await delay(50);
	assert.equal(admitted, false, 'a new request waits while the gate is closed');
	gate.open();
	const release = await held;
	assert.ok(release);
	release();
	await gate.close();
	assert.equal(await gate.request(), null, 'a request gives up after the hold time');
	gate.open();
});

test('a request that arrives while the runtime is paused completes after it resumes', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-pause-'));
	const runtime = await openLocalRuntime({ dataDir, handleSignals: false });
	const server = await listenLocalServer(runtime, { port: 0 });
	try {
		const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
		const resume = await runtime.pause();
		let settled = false;
		const response = fetch(`${origin}/.well-known/crate`).finally(() => { settled = true; });
		await delay(300);
		assert.equal(settled, false);
		await resume();
		assert.equal((await response).status, 200);
		assert.equal((await runtime.db.prepare('PRAGMA quick_check').first())?.quick_check, 'ok', 'the resumed runtime has a working database');
	} finally {
		await new Promise(resolve => server.close(resolve));
		await runtime.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('backing up a running server mid-sync restores every committed file with its bytes', { timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), 'crate-online-backup-'));
	const dataDir = join(root, 'server');
	const restored = join(root, 'restored');
	/** @type {Awaited<ReturnType<typeof startServer>> | undefined} */
	let server;
	try {
		const token = await prepareServer(dataDir);
		let port = await freePort();
		let origin = `http://127.0.0.1:${port}`;
		server = await startServer(dataDir, port);
		const info = await (await fetch(`${origin}/.well-known/crate`)).json();
		const headers = { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': String(info.protocol.current) };
		/** @type {Map<string, string>} */
		const bodies = new Map();
		const upload = async (/** @type {string} */ path) => {
			const body = `bytes of ${path} ${randomUUID()}`;
			bodies.set(path, body);
			const response = await fetch(`${origin}/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: {
				...headers, 'Content-Type': 'text/plain', 'X-Crate-Expected-Hash': 'absent',
				'X-Crate-Upload-Operation': `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${randomUUID()}`,
			}, body });
			assert.equal(response.status, 200, `${path}: ${await response.text()}`);
		};
		for (let index = 0; index < 10; index++) await upload(`before/${index}.md`);
		// Keep syncing while the backup runs; every upload must succeed, held or not.
		let syncing = true;
		const sync = (async () => { for (let index = 0; syncing; index++) await upload(`during/${index}.md`); })();
		const { stdout } = await run(process.execPath, [cli, 'backup', '--output', join(root, 'backup'), '--data-dir', dataDir]);
		syncing = false;
		await sync;
		assert.match(stdout, /Backup verified: .*\nSync paused for \d+\.\d s/);
		assert.equal(server.child.exitCode, null, 'the server keeps running');
		server.child.kill('SIGTERM');
		assert.equal((await server.exited)[0], 0, server.output);
		server = undefined;

		await restoreLocalServer(restored, join(root, 'backup'));
		const check = await openLocalRuntime({ dataDir: restored, administrative: true });
		/** @type {string[]} */
		let paths;
		try {
			assert.equal((await check.db.prepare('PRAGMA quick_check').first())?.quick_check, 'ok');
			paths = (await check.db.prepare('SELECT path FROM files').all()).results.map(row => row.path);
		} finally { await check.close(); }
		for (let index = 0; index < 10; index++) assert.ok(paths.includes(`before/${index}.md`));
		port = await freePort();
		origin = `http://127.0.0.1:${port}`;
		server = await startServer(restored, port);
		// No row without its bytes: the database and the stored objects were copied together.
		for (const path of paths) {
			const response = await fetch(`${origin}/sync/download?path=${encodeURIComponent(path)}`, { headers });
			assert.equal(response.status, 200, path);
			assert.equal(await response.text(), bodies.get(path), path);
		}
	} finally {
		if (server?.child.exitCode === null) { server.child.kill('SIGTERM'); await server.exited; }
		await rm(root, { recursive: true, force: true });
	}
});

test('automatic backups run daily, share unchanged files and keep the newest', { timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), 'crate-auto-backup-'));
	const dataDir = join(root, 'server');
	const dir = join(root, 'backups');
	const runtime = await openLocalRuntime({ dataDir, handleSignals: false });
	let now = Date.parse('2026-11-01T03:00:00Z');
	const backups = startBackups({ dataDir, runtime, now: () => now, firstCheck: 3_600_000 });
	try {
		await (await runtime.mf.getR2Bucket('BUCKET')).put('unchanged', 'stays the same');
		await backups.check();
		assert.deepEqual(await listAutomaticBackups(dir), [], 'nothing runs while automatic backups are off');
		await saveAutoBackup(dataDir, { dir, keep: 2 });
		await mkdir(join(dir, 'crate-manual'));
		await writeFile(join(dir, 'notes.txt'), 'mine');

		await backups.check();
		const [first] = await listAutomaticBackups(dir);
		assert.equal(first.path, join(dir, automaticBackupName(now)));
		now += 60 * 60_000;
		await backups.check();
		assert.equal((await listAutomaticBackups(dir)).length, 1, 'a backup less than a day old is fresh');

		now += 24 * 60 * 60_000;
		await (await runtime.mf.getR2Bucket('BUCKET')).put('new', 'added later');
		await backups.check();
		const [second] = await listAutomaticBackups(dir);
		assert.notEqual(second.path, first.path);
		/** @param {string} backup */
		const blobs = async backup => {
			/** @type {Map<string, number>} */
			const found = new Map();
			const walk = async (/** @type {string} */ path) => {
				for (const entry of await readdir(path, { withFileTypes: true })) {
					const full = join(path, entry.name);
					if (entry.isDirectory()) await walk(full);
					else if (path.endsWith('/blobs')) found.set(full.slice(backup.length), (await stat(full)).ino);
				}
			};
			await walk(backup);
			return found;
		};
		const firstBlobs = await blobs(first.path);
		const secondBlobs = await blobs(second.path);
		assert.equal(firstBlobs.size, 1);
		assert.equal(secondBlobs.size, 2);
		for (const [path, inode] of firstBlobs) assert.equal(secondBlobs.get(path), inode, 'an unchanged object is hard-linked');

		now += 24 * 60 * 60_000;
		await backups.check();
		const kept = await listAutomaticBackups(dir);
		assert.equal(kept.length, 2);
		assert.ok(!kept.some(backup => backup.path === first.path), 'the oldest automatic backup is deleted');
		assert.deepEqual((await readdir(dir)).filter(name => !name.startsWith('crate-2')).sort(), ['crate-manual', 'notes.txt']);
		// Deleting a backup leaves the ones that shared its files intact.
		await restoreLocalServer(join(root, 'restored'), second.path);
	} finally {
		await backups.close();
		await runtime.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a failed automatic backup is reported and retried', async () => {
	const root = await mkdtemp(join(tmpdir(), 'crate-auto-backup-failure-'));
	const dataDir = join(root, 'server');
	await mkdir(dataDir);
	await saveAutoBackup(dataDir, { dir: join(root, 'backups'), keep: 7 });
	let fail = true;
	const backups = startBackups({ dataDir, runtime: { pause: async () => async () => {} }, firstCheck: 3_600_000,
		backup: async (_, output) => {
			if (fail) throw new Error('disk unplugged');
			await mkdir(output);
			await writeFile(join(output, 'backup.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString(), data: [], remote: [] }));
			return output;
		} });
	try {
		await backups.check();
		assert.equal((await backups.status()).lastFailure?.message, 'disk unplugged');
		fail = false;
		await backups.check();
		assert.equal((await backups.status()).lastFailure, null);
		assert.equal((await listAutomaticBackups(join(root, 'backups'))).length, 1);
	} finally {
		await backups.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a backup that would fill the disk is refused before anything is copied', async () => {
	const root = await mkdtemp(join(tmpdir(), 'crate-backup-space-'));
	const dataDir = join(root, 'server');
	await mkdir(dataDir);
	await writeFile(join(dataDir, 'server.json'), '{}');
	try {
		await assert.rejects(backupLocalServer(dataDir, join(root, 'backup'), { available: async () => 512 * 1024 ** 2 }), /Not enough free space/);
		assert.deepEqual(await readdir(root), ['server']);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('automatic backups refuse a directory inside the server data', async () => {
	const root = await mkdtemp(join(tmpdir(), 'crate-auto-backup-place-'));
	try {
		await assert.rejects(saveAutoBackup(join(root, 'server'), { dir: join(root, 'server', 'backups'), keep: 7 }), /outside the server data/);
		await assert.rejects(saveAutoBackup(join(root, 'server'), { dir: join(root, 'backups'), keep: 0 }), /--keep/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a blob removed while a running server is backed up is left out', async () => {
	const root = await mkdtemp(join(tmpdir(), 'crate-backup-removed-'));
	const dataDir = join(root, 'server');
	await mkdir(join(dataDir, 'r2', 'blobs'), { recursive: true });
	await writeFile(join(dataDir, 'server.json'), '{}');
	for (const name of ['kept', 'removed']) await writeFile(join(dataDir, 'r2', 'blobs', name), name);
	try {
		const output = await backupLocalServer(dataDir, join(root, 'backup'), {
			// Maintenance deletes an expired object after the backup listed the blobs.
			available: async () => { await rm(join(dataDir, 'r2', 'blobs', 'removed')); return 1024 ** 4; },
			pause: async () => async () => {},
		});
		const manifest = JSON.parse(await readFile(join(output, 'backup.json'), 'utf8'));
		assert.deepEqual(manifest.data.map(file => file.path).sort(), ['r2/blobs/kept', 'server.json']);
		assert.deepEqual(await readdir(join(output, 'data', 'r2', 'blobs')), ['kept']);
	} finally { await rm(root, { recursive: true, force: true }); }
});
