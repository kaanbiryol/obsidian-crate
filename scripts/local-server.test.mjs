import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { openLocalRuntime, issueLocalDevice, normalizeLocalOrigin } from './local-server-runtime.mjs';
import { listenLocalServer } from './local-server-http.mjs';

test('local origin requires HTTPS except on the server computer', () => {
	assert.equal(normalizeLocalOrigin('http://localhost:8787/'), 'http://localhost:8787');
	assert.equal(normalizeLocalOrigin('https://crate.example.com'), 'https://crate.example.com');
	for (const value of ['http://192.168.1.2:8787', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=x']) {
		assert.throws(() => normalizeLocalOrigin(value));
	}
});

test('damaged metadata and missing storage cannot silently create a fresh server', { timeout: 20_000 }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-local-damage-'));
	try {
		const runtime = await openLocalRuntime({ dataDir, administrative: true });
		await runtime.close();
		const metadataPath = join(dataDir, 'server.json');
		const metadata = await readFile(metadataPath, 'utf8');
		await writeFile(metadataPath, 'null');
		await assert.rejects(openLocalRuntime({ dataDir }), /matching schema\/runtime/);
		await rm(metadataPath);
		await assert.rejects(openLocalRuntime({ dataDir }), /without server.json/);
		await writeFile(metadataPath, metadata);
		await rm(join(dataDir, 'resources'), { recursive: true });
		await assert.rejects(openLocalRuntime({ dataDir }), /database is missing/);
	} finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('CLI initializes a device offline and releases the directory on SIGTERM', { timeout: 30_000 }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-local-cli-'));
	let child;
	try {
		const cli = new URL('./local-server.mjs', import.meta.url).pathname;
		const { stdout } = await promisify(execFile)(process.execPath, [cli, 'add-device', '--name', 'CLI test', '--data-dir', dataDir]);
		const token = /Access token \(shown once\): ([a-f0-9]{64})/.exec(stdout)?.[1];
		assert.ok(token, 'CLI must issue a private per-device credential');
		const socket = createServer();
		await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
		const port = socket.address().port;
		await new Promise(resolve => socket.close(resolve));
		child = spawn(process.execPath, [cli, 'start', '--data-dir', dataDir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
		const exited = once(child, 'exit');
		let output = '';
		let errors = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { errors += chunk; });
		const deadline = Date.now() + 10_000;
		while (!output.includes('Press Ctrl+C')) {
			assert.equal(child.exitCode, null, errors);
			assert.ok(Date.now() < deadline, `CLI startup timed out: ${errors}`);
			await delay(50);
		}
		assert.ok(!output.includes(token), 'Startup must not print existing credentials');
		const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } });
		assert.equal(response.status, 200);
		await response.text();
		child.kill('SIGTERM');
		const [code] = await exited;
		assert.equal(code, 0, errors);
		const reopened = await openLocalRuntime({ dataDir, administrative: true });
		try { assert.equal((await reopened.db.prepare('SELECT COUNT(*) AS count FROM auth_tokens').first()).count, 1); }
		finally { await reopened.close(); }
	} finally {
		if (child?.exitCode === null) child.kill('SIGKILL');
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('interrupting CLI during storage startup still releases its lock', { timeout: 20_000 }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-local-interrupt-'));
	const child = spawn(process.execPath, [new URL('./local-server.mjs', import.meta.url).pathname, 'start', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
	const exited = once(child, 'exit');
	let output = '';
	let errors = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { errors += chunk; });
	try {
		const deadline = Date.now() + 10_000;
		while (!(await stat(join(dataDir, 'server.lock')).catch(() => null))) {
			assert.equal(child.exitCode, null, errors);
			assert.ok(Date.now() < deadline, errors);
			await delay(2);
		}
		assert.ok(!output.includes('Press Ctrl+C'), 'Interrupt while startup owns the lock, before serving');
		child.kill('SIGTERM');
		assert.equal((await exited)[0], 0, errors);
		assert.equal(await stat(join(dataDir, 'server.lock')).catch(() => null), null);
	} finally {
		if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('real HTTP sync, credentials, receipts and durable alarms survive a local server restart', { timeout: 60_000 }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-local-test-'));
	let runtime;
	let server;
	const start = async () => {
		runtime = await openLocalRuntime({ dataDir });
		server = await listenLocalServer(runtime, { port: 0 });
		return `http://127.0.0.1:${server.address().port}`;
	};
	const stop = async () => {
		if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		server = null;
		await runtime?.close();
		runtime = null;
	};
	try {
		let origin = await start();
		await assert.rejects(openLocalRuntime({ dataDir }), /locked/);
		const first = await issueLocalDevice(runtime.db, 'Mac');
		const second = await issueLocalDevice(runtime.db, 'Phone');
		const info = await (await fetch(`${origin}/.well-known/crate`)).json();
		const headers = { Authorization: `Bearer ${first.token}`, 'X-Crate-Protocol': String(info.protocol.current) };
		assert.equal((await fetch(`${origin}/health`)).status, 401);
		assert.equal((await fetch(`${origin}/health`, { headers })).status, 200);
		assert.equal((await fetch(`${origin}/health`, { headers: { ...headers, 'MF-Route-Override': 'unknown-worker' } })).status, 200);
		for (const path of ['/cdn-cgi/local/platform-proxy', '/cdn-cgi/local/r2/s3', '/__cf_local/stream', '/%63dn-cgi/local/explorer']) {
			assert.equal((await fetch(`${origin}${path}`)).status, 404);
		}
		assert.equal((await fetch(`${origin}/notifications`)).status, 200);
		const row = await runtime.db.prepare('SELECT token_hash FROM auth_tokens WHERE id = ?').bind(first.id).first();
		assert.equal(row.token_hash, createHash('sha256').update(first.token).digest('hex'));
		await runtime.db.prepare("INSERT INTO initial_import(id, token, state) VALUES (1, 'test', 'complete')").run();
		const operation = `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${randomUUID()}`;
		const upload = () => fetch(`${origin}/sync/upload?path=hello.txt`, { method: 'PUT', headers: {
			...headers, 'Content-Type': 'text/plain', 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operation,
		}, body: 'persistent local bytes' });
		let response = await upload();
		assert.equal(response.status, 200, await response.clone().text());
		const written = await response.json();
		// A failed transaction must not leave a partially registered device.
		await assert.rejects(runtime.db.batch([
			runtime.db.prepare("UPDATE auth_tokens SET device_name = 'wrong' WHERE id = ?").bind(first.id),
			runtime.db.prepare('INSERT INTO crate_schema (id, version, created_version) VALUES (2, 1, 1)'),
		]));
		assert.equal((await runtime.db.prepare('SELECT device_name FROM auth_tokens WHERE id = ?').bind(first.id).first()).device_name, 'Mac');

		// Persist a real ReminderAlarm with verified authority. With no push
		// recipients it completes locally when its alarm wakes after restart.
		const due = new Date(Date.now() + 3000).toISOString();
		const parserSource = await readFile(new URL('../src/cloudflare/worker/reminders-web/reminder-cache/types.ts', import.meta.url), 'utf8');
		const parserVersion = Number(/REMINDER_CACHE_PARSER_VERSION = (\d+)/.exec(parserSource)[1]);
		const file = await runtime.db.prepare("SELECT storage_key FROM files WHERE path = 'hello.txt'").first();
		await runtime.db.prepare("INSERT INTO notification_policy (id, folder_path, timezone, revision, enabled) VALUES (1, 'Reminders', 'UTC', 'policy', 1)").run();
		await runtime.db.prepare("INSERT INTO reminder_source_state (file_path, file_revision, parser_version, verified) VALUES ('hello.txt', ?, ?, 1)")
			.bind(file.storage_key, parserVersion).run();
		await runtime.db.prepare("INSERT INTO reminder_projections (reminder_id, file_path, file_revision, notification_token, policy_revision) VALUES ('restart-alarm', 'hello.txt', ?, 'job', 'policy')")
			.bind(file.storage_key).run();
		await runtime.db.prepare("INSERT INTO notification_jobs (reminder_id, job_token, operation, payload_json, available_at) VALUES ('restart-alarm', 'job', 'schedule', '{}', ?)")
			.bind(Date.now() + 60_000).run();
		const alarms = await runtime.mf.getDurableObjectNamespace('REMINDER_ALARMS');
		const alarm = alarms.get(alarms.idFromName('restart-alarm'));
		response = await alarm.fetch('https://do/', { method: 'PUT', body: JSON.stringify({
			reminderId: 'restart-alarm', content: 'Restart test', dueDatetime: due, jobToken: 'job',
		}) });
		assert.equal(response.status, 200, await response.clone().text());
		await response.text();
		assert.ok(await runtime.db.prepare("SELECT reminder_id FROM scheduled_reminders WHERE reminder_id = 'restart-alarm'").first());
		await stop();
		await delay(3100);
		origin = await start();
		assert.equal((await fetch(`${origin}/health`, { headers })).status, 200);
		response = await fetch(`${origin}/sync/download?path=hello.txt`, { headers: { Authorization: `Bearer ${second.token}` } });
		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'persistent local bytes');
		response = await upload();
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(await response.json(), written);
		assert.equal((await runtime.db.prepare('SELECT COUNT(*) AS count FROM changelog').first()).count, 1);
		const deadline = Date.now() + 10_000;
		while (await runtime.db.prepare("SELECT reminder_id FROM scheduled_reminders WHERE reminder_id = 'restart-alarm'").first()) {
			assert.ok(Date.now() < deadline, 'Persisted alarm did not wake after restart');
			await delay(100);
		}
		response = await fetch(`${origin}/auth/tokens`, { method: 'DELETE', headers, body: JSON.stringify({ id: second.id }) });
		assert.equal(response.status, 200, await response.clone().text());
		await response.text();
		assert.equal((await fetch(`${origin}/health`, { headers: { Authorization: `Bearer ${second.token}` } })).status, 401);
		// The same server serves real PWA assets and exchanges scoped sessions.
		response = await fetch(`${origin}/notifications/app.js`);
		assert.equal(response.status, 200);
		assert.ok((await response.text()).length > 1000);
		response = await fetch(`${origin}/notifications/reminders-enrollment-token`, {
			method: 'POST', headers, body: JSON.stringify({ folderPath: 'Reminders' }),
		});
		assert.equal(response.status, 200, await response.clone().text());
		const enrollment = await response.json();
		response = await fetch(`${origin}/notifications/reminders-exchange`, {
			method: 'POST', headers: { 'X-Crate-Protocol': String(info.protocol.current) },
			body: JSON.stringify({ token: enrollment.browserToken }),
		});
		assert.equal(response.status, 200, await response.clone().text());
		const web = await response.json();
		const webHeaders = { Authorization: `Bearer ${web.authToken}` };
		assert.equal((await fetch(`${origin}/health`, { headers: webHeaders })).status, 200);
		assert.equal((await fetch(`${origin}/sync/manifest`, { headers: webHeaders })).status, 403);
		assert.equal((await fetch(`${origin}/reminders/list?folderPath=Private`, { headers: webHeaders })).status, 403);
		await runtime.db.prepare('UPDATE crate_schema SET version = 999 WHERE id = 1').run();
		await stop();
		await assert.rejects(openLocalRuntime({ dataDir }), /Unsupported local database schema/);
		assert.equal(JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8')).format, 1);
	} finally {
		await stop();
		await rm(dataDir, { recursive: true, force: true });
	}
});
