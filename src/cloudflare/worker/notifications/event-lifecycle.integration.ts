/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { sha256Hex } from '@/platform/sha256';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('device', ?, 'vault')")
		.bind(await sha256Hex('event-token')).run();
	// Ordinary scheduling tests start after the one-time legacy storage migration.
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('processes a saved reminder without cron and leaves both coordinators idle', async () => {
	const request = (path: string, init: RequestInit) => worker.fetch(new Request(`https://event.test${path}`, {
		...init, headers: { Authorization: 'Bearer event-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers },
	}), env);
	expect((await request('/reminders/notification-policy', { method: 'POST', body: JSON.stringify({
		folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00',
	}) })).status).toBe(200);
	const id = '11111111-1111-4111-8111-111111111111';
	expect((await request('/sync/upload?path=Reminders/Inbox.md', { method: 'PUT',
		headers: { 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)) },
		body: `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`,
	})).status).toBe(200);

	const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
	await coordinator.fetch('https://do/ensure', { method: 'POST' });
	for (let pass = 0; pass < 5; pass++) {
		await runDurableObjectAlarm(coordinator);
		// This request shares the coordinator lock, so any in-flight pass finishes first.
		await coordinator.fetch('https://do/ensure', { method: 'POST' });
	}
	expect(await env.DB.prepare('SELECT due_at FROM reminder_projections WHERE reminder_id = ?').bind(id).first())
		.toEqual({ due_at: Date.parse('2099-01-02T10:00:00.000Z') });
	expect(await runInDurableObject(coordinator, (_instance, state) => state.storage.getAlarm())).toBeNull();
	expect(await runDurableObjectAlarm(coordinator)).toBe(false);

	const maintenance = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/maintenance'));
	expect(await runDurableObjectAlarm(maintenance)).toBe(true);
	expect(await runInDurableObject(maintenance, (_instance, state) => state.storage.getAlarm())).toBeNull();
	expect(await runDurableObjectAlarm(maintenance)).toBe(false);
	// One dispatcher alarm covers every scheduled reminder; no per-reminder object exists.
	const dispatcher = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/notification-dispatch'));
	expect(await runInDurableObject(dispatcher, (_instance, state) => state.storage.getAlarm()))
		.toBe(Date.parse('2099-01-02T10:00:00.000Z'));
	const reminder = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(id));
	expect(await runInDurableObject(reminder, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it('does not wake notifications for settings, binary uploads or notes outside the feature folders', async () => {
	const headers = { Authorization: 'Bearer event-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current) };
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	await env.DB.prepare("INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, 1, 'Reading', 'g', 'r')").run();
	expect((await worker.fetch(new Request('https://event.test/sync/upload?path=Notes/plain.md', {
		method: 'PUT', headers: { ...headers, 'X-Crate-Expected-Hash': 'absent',
			'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)) }, body: '- [ ] Not a reminder note',
	}), env)).status).toBe(200);
	expect((await worker.fetch(new Request('https://event.test/settings', {
		method: 'PUT', headers, body: JSON.stringify({ expectedVersion: null, settings: {
			ignorePatterns: [], syncInterval: 60, pushEnabled: false,
		} }),
	}), env)).status).toBe(200);
	expect((await worker.fetch(new Request('https://event.test/sync/upload?path=image.bin', {
		method: 'PUT', headers: { ...headers, 'X-Crate-Expected-Hash': 'absent',
			'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)) }, body: 'bytes',
	}), env)).status).toBe(200);
	const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
	expect(await runInDurableObject(coordinator, (_instance, state) => state.storage.getAlarm())).toBeNull();
	// A wake would also have recorded a processing run with a fresh retry budget.
	expect(await runInDurableObject(coordinator, (_instance, state) => state.storage.get('notificationRun'))).toBeUndefined();
});

it('wakes notifications from Reading reads only while they rebuild the library index', async () => {
	const headers = { Authorization: 'Bearer event-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current) };
	await env.DB.prepare("INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, 0, 'Reading', 'g', 'r')").run();
	const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
	const run = () => runInDurableObject(coordinator, (_instance, state) => state.storage.get('notificationRun'));
	const read = (path: string) => worker.fetch(new Request(`https://event.test${path}`, { headers }), env);
	// The first read builds the index, which can queue article extraction.
	expect((await read('/reading/items')).status).toBe(200);
	expect(await run()).toBeDefined();
	// Let the armed pass finish before clearing its record, so a late alarm cannot recreate it.
	while (await runDurableObjectAlarm(coordinator)) await coordinator.fetch('https://do/ensure', { method: 'POST' });
	await runInDurableObject(coordinator, async (_instance, state) => { await state.storage.delete('notificationRun'); await state.storage.deleteAlarm(); });
	expect((await read('/reading/items')).status).toBe(200);
	await read('/reading/item?id=missing');
	expect(await run()).toBeUndefined();
	expect(await runInDurableObject(coordinator, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

const vaultRequest = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://event.test${path}`, {
	...init, headers: { Authorization: 'Bearer event-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers },
}), env);
const coordinatorAlarm = () => runInDurableObject(env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')),
	(_instance, state) => state.storage.getAlarm());
async function deletion(paths: string[]) {
	const files = await env.DB.prepare('SELECT path, hash, storage_key FROM files WHERE path IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(paths)).all<{ path: string; hash: string; storage_key: string }>();
	return JSON.stringify({ files: files.results.map(file => ({ path: file.path, expectedHash: file.hash, expectedRevision: file.storage_key })) });
}

it('arms no notification pass for a deletion outside the feature folders', async () => {
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	for (const path of ['Notes/a.md', 'Notes/b.md', 'Reminders/image.png']) {
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, `# ${path}`, null);
	}
	const response = await vaultRequest('/sync/batch-delete', { method: 'POST', body: await deletion(['Notes/a.md', 'Notes/b.md', 'Reminders/image.png']) });
	expect(response.status).toBe(200);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
	expect(await coordinatorAlarm()).toBeNull();
	expect(await runInDurableObject(env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')),
		(_instance, state) => state.storage.get('notificationRun'))).toBeUndefined();
});

it('arms the pass before a reminder note deletion commits, so a lost response still cancels its schedule', async () => {
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Notes/a.md', '# Note', null);
	const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
	// Alarms also fire on their own; the lock-sharing request waits for an in-flight pass.
	const settle = async () => {
		for (let pass = 0; pass < 5; pass++) {
			await runDurableObjectAlarm(coordinator);
			await coordinator.fetch('https://do/ensure', { method: 'POST' });
		}
	};
	await coordinator.fetch('https://do/project', { method: 'POST' });
	await settle();
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_projections WHERE due_at IS NOT NULL').first()).toEqual({ n: 1 });
	// The commit applies, then its response is lost. Nothing else arms the coordinator.
	const prototype = Object.getPrototypeOf(env.DB) as { batch: (statements: Array<{ statement?: string }>) => Promise<unknown[]> };
	const batch = prototype.batch;
	vi.spyOn(prototype, 'batch').mockImplementation(async function (this: unknown, statements) {
		const results = await batch.call(this, statements);
		if (statements.some(statement => statement.statement?.startsWith('DELETE FROM files'))) throw new Error('Lost commit response');
		return results;
	});
	const response = await vaultRequest('/sync/batch-delete', { method: 'POST', body: await deletion(['Reminders/Inbox.md', 'Notes/a.md']) });
	vi.mocked(prototype.batch).mockRestore();
	expect(response.status).not.toBe(200);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
	await settle();
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_projections').first()).toEqual({ n: 0 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_projection_jobs').first()).toEqual({ n: 0 });
});

it('runs a role alarm by its object name, without a stored role flag', async () => {
	const dispatcher = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/notification-dispatch'));
	await runInDurableObject(dispatcher, async (_instance, state) => {
		expect(await state.storage.get('reminderDispatcher')).toBeUndefined();
		// A failed earlier pass; a pass that runs clears it.
		await state.storage.put('dispatchFailures', 3);
		await state.storage.setAlarm(Date.now() + 60_000);
	});
	expect(await runDurableObjectAlarm(dispatcher)).toBe(true);
	expect(await runInDurableObject(dispatcher, (_instance, state) => state.storage.get('dispatchFailures'))).toBeUndefined();
});
