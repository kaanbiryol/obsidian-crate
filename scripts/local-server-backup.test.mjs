import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { backupLocalServer, checkLocalUpgrade, restoreLocalServer } from './local-server-backup.mjs';
import { issueLocalDevice, openLocalRuntime } from './local-server-runtime.mjs';

test('verified backup restores files, credentials and durable alarm storage into a fresh server', { timeout: 60_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-backup-test-'));
	const source = join(directory, 'source'), backup = join(directory, 'backup'), target = join(directory, 'restored');
	let runtime;
	try {
		runtime = await openLocalRuntime({ dataDir: source });
		const credential = await issueLocalDevice(runtime.db, 'Test');
		await (await runtime.mf.getR2Bucket('BUCKET')).put('backup-test', 'persistent bytes');
		const parser = await readFile(new URL('../src/cloudflare/worker/reminders-web/reminder-cache/types.ts', import.meta.url), 'utf8');
		const parserVersion = Number(/REMINDER_CACHE_PARSER_VERSION = (\d+)/.exec(parser)[1]);
		await runtime.db.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('backup.txt', 'backup.txt', 'backup-test')").run();
		await runtime.db.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision, enabled) VALUES (1, 'Reminders', 'UTC', 'policy', 1)").run();
		await runtime.db.prepare("INSERT INTO reminder_source_state(file_path, file_revision, parser_version, verified) VALUES ('backup.txt', 'backup-test', ?, 1)").bind(parserVersion).run();
		await runtime.db.prepare("INSERT INTO reminder_projections(reminder_id, file_path, file_revision, notification_token, policy_revision) VALUES ('backup-reminder', 'backup.txt', 'backup-test', 'job', 'policy')").run();
		await runtime.db.prepare("INSERT INTO notification_jobs(reminder_id, job_token, operation, payload_json, available_at) VALUES ('backup-reminder', 'job', 'schedule', '{}', ?)").bind(Date.now() + 60_000).run();
		const namespace = await runtime.mf.getDurableObjectNamespace('REMINDER_ALARMS');
		const response = await namespace.get(namespace.idFromName('backup-reminder')).fetch('https://do/', {
			method: 'PUT', body: JSON.stringify({ reminderId: 'backup-reminder', jobToken: 'job', content: 'Restored alarm', dueDatetime: new Date(Date.now() + 10_000).toISOString() }),
		});
		assert.equal(response.status, 200);
		await response.text();
		assert.ok(await runtime.db.prepare("SELECT reminder_id FROM scheduled_reminders WHERE reminder_id = 'backup-reminder'").first());
		await assert.rejects(backupLocalServer(source, backup), /locked/);
		await runtime.close(); runtime = null;
		const before = await readFile(join(source, 'server.json'), 'utf8');
		assert.ok((await checkLocalUpgrade(source)).to > 0);
		assert.equal(await readFile(join(source, 'server.json'), 'utf8'), before);
		await backupLocalServer(source, backup);
		await assert.rejects(backupLocalServer(source, backup), /already exists/);
		await restoreLocalServer(target, backup);
		runtime = await openLocalRuntime({ dataDir: target });
		assert.equal(await (await (await runtime.mf.getR2Bucket('BUCKET')).get('backup-test')).text(), 'persistent bytes');
		assert.equal((await runtime.mf.dispatchFetch('http://localhost:8787/health', { headers: { Authorization: `Bearer ${credential.token}` } })).status, 200);
		const deadline = Date.now() + 15_000;
		while (await runtime.db.prepare("SELECT reminder_id FROM scheduled_reminders WHERE reminder_id = 'backup-reminder'").first()) {
			assert.ok(Date.now() < deadline, 'Restored durable alarm must wake and finish its empty-recipient delivery');
			await delay(100);
		}
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
