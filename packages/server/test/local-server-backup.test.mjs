import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { backupLocalServer, checkLocalUpgrade, prepareMigrationBackup, readLastBackup, restoreLocalServer } from '../src/local-server-backup.mjs';
import { issueLocalDevice, openLocalRuntime } from '../src/local-server-runtime.mjs';

test('verified backup restores files, credentials and durable alarm storage into a fresh server', { timeout: 60_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-backup-test-'));
	const source = join(directory, 'source'), backup = join(directory, 'backup'), target = join(directory, 'restored');
	let runtime;
	try {
		runtime = await openLocalRuntime({ dataDir: source });
		const credential = await issueLocalDevice(runtime.db, 'Test');
		// Read before the synthetic reminder rows below: the first sync read initializes notification processing, which rebuilds projections from files.
		const storageId = async () => {
			const { protocol } = await (await runtime.mf.dispatchFetch('http://localhost:8787/.well-known/crate')).json();
			const response = await runtime.mf.dispatchFetch('http://localhost:8787/sync/check?since=0', { headers: {
				Authorization: `Bearer ${credential.token}`, 'X-Crate-Protocol': String(protocol.current) } });
			assert.equal(response.status, 200, await response.clone().text());
			return (await response.json()).storageId;
		};
		const sourceStorageId = await storageId();
		assert.match(sourceStorageId, /^[a-f0-9]{32}$/);
		await (await runtime.mf.getR2Bucket('BUCKET')).put('backup-test', 'persistent bytes');
		const parser = await readFile(new URL('../../../src/cloudflare/worker/reminders/cache/types.ts', import.meta.url), 'utf8');
		const parserVersion = Number(/REMINDER_CACHE_PARSER_VERSION = (\d+)/.exec(parser)[1]);
		await runtime.db.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('backup.txt', 'backup.txt', 'backup-test')").run();
		await runtime.db.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision, enabled) VALUES (1, 'Reminders', 'UTC', 'policy', 1)").run();
		await runtime.db.prepare("INSERT INTO reminder_source_state(file_path, file_revision, parser_version, verified) VALUES ('backup.txt', 'backup-test', ?, 1)").bind(parserVersion).run();
		const due = new Date(Date.now() + 10_000).toISOString();
		await runtime.db.prepare(`INSERT INTO reminder_projections(reminder_id, file_path, notification_token, due_datetime, content, due_at)
			VALUES ('backup-reminder', 'backup.txt', 'job', ?, 'Restored alarm', ?)`).bind(due, Date.parse(due)).run();
		const namespace = await runtime.mf.getDurableObjectNamespace('REMINDER_ALARMS');
		const response = await namespace.get(namespace.idFromName('__crate__/notification-dispatch')).fetch('https://do/arm-dispatcher', { method: 'POST', body: '{}' });
		assert.equal(response.status, 204);
		await response.text();
		await assert.rejects(backupLocalServer(source, backup), /locked/);
		await runtime.close(); runtime = null;
		const before = await readFile(join(source, 'server.json'), 'utf8');
		assert.ok((await checkLocalUpgrade(source)).to > 0);
		assert.equal(await readFile(join(source, 'server.json'), 'utf8'), before);
		// A crash can leave the control socket in the data directory; backups skip it.
		const leftover = createServer();
		await new Promise(resolve => leftover.listen(join(source, 'control.sock'), resolve));
		let created;
		try { created = await backupLocalServer(source, backup); }
		finally { await new Promise(resolve => leftover.close(resolve)); }
		await assert.rejects(backupLocalServer(source, backup), /already exists/);
		// The source records its last backup for status reports; the backup itself does not carry it.
		const recorded = await readLastBackup(source);
		assert.equal(recorded?.output, created);
		assert.equal(recorded?.createdAt, JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8')).createdAt);
		await restoreLocalServer(target, backup);
		assert.equal(await readLastBackup(target), null);
		runtime = await openLocalRuntime({ dataDir: target });
		assert.equal(await (await (await runtime.mf.getR2Bucket('BUCKET')).get('backup-test')).text(), 'persistent bytes');
		assert.equal((await runtime.mf.dispatchFetch('http://localhost:8787/health', { headers: { Authorization: `Bearer ${credential.token}` } })).status, 200);
		const deadline = Date.now() + 15_000;
		while (!await runtime.db.prepare("SELECT reminder_id FROM reminder_projections WHERE reminder_id = 'backup-reminder' AND delivered_due IS NOT NULL").first()) {
			assert.ok(Date.now() < deadline, 'Restored dispatcher alarm must wake and finish its empty-recipient delivery');
			await delay(100);
		}
		// Devices must see a restored server as another server, even once it catches up with them.
		const restoredStorageId = await storageId();
		assert.match(restoredStorageId, /^[a-f0-9]{32}$/);
		assert.notEqual(restoredStorageId, sourceStorageId);
		await runtime.close(); runtime = null;
		await assert.rejects(restoreLocalServer(target, backup), /empty data directory/);
		await writeFile(join(backup, 'data/server.json'), '{}');
		await assert.rejects(restoreLocalServer(join(directory, 'damaged'), backup), /missing, changed, or damaged/);
		const metadata = JSON.parse(before);
		await writeFile(join(source, 'server.json'), JSON.stringify({ ...metadata, runtimeVersion: 'incompatible' }));
		await assert.rejects(checkLocalUpgrade(source), /tested migration/);
		assert.equal(JSON.parse(await readFile(join(source, 'server.json'), 'utf8')).runtimeVersion, 'incompatible');
	} finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a retried migration reuses its backup only while it is the latest, and never fails on its name', { timeout: 60_000 }, async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), 'crate-migration-backup-test-')));
	const dataDir = join(directory, 'server'), output = join(directory, 'backups', 'before-migration-r1-to-r2');
	try {
		await (await openLocalRuntime({ dataDir, administrative: true })).close();
		assert.equal(await prepareMigrationBackup(dataDir, output), output);
		// A restart after a failed attempt reuses it.
		assert.equal(await prepareMigrationBackup(dataDir, output), output);
		assert.deepEqual(await readdir(join(directory, 'backups')), ['before-migration-r1-to-r2']);
		// A later backup, or a lost record, makes it stale: keep it and back up beside it instead of failing.
		await backupLocalServer(dataDir, join(directory, 'later'));
		assert.match(await prepareMigrationBackup(dataDir, output), /before-migration-r1-to-r2-\d{8}T\d{6}Z$/);
		await rm(join(dataDir, 'last-backup.json'));
		await new Promise(resolve => setTimeout(resolve, 1100));
		assert.match(await prepareMigrationBackup(dataDir, output), /before-migration-r1-to-r2-\d{8}T\d{6}Z$/);
		assert.equal((await readdir(join(directory, 'backups'))).length, 3);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
