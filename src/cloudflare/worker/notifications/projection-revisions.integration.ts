/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { handleBatchDelete } from '../sync/batch/delete';
import { drainNotificationProjections, notificationDatetime } from './projection';
import { handleNotificationPolicy } from './policy';
import { deliverDueReminders } from './dispatcher';
import { runNotificationCoordinator } from './coordinator';
import { getStoredFileRow } from '../sync/storage';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const policy = { folderPath: 'Reminders', timezone: 'America/New_York', allDayTime: '09:00', revision: 'policy1' };
async function configure() {
	await handleNotificationPolicy(new Request('https://test/reminders/notification-policy', { method: 'POST', body: JSON.stringify(policy) }), env.DB);
}
const note = '- [ ] Due 2099-01-02T10:00:00.000Z <!-- crate-id:11111111-1111-4111-8111-111111111111 -->';
async function jobs() { expect((await env.DB.prepare('SELECT last_error FROM notification_projection_jobs WHERE last_error IS NOT NULL').all()).results).toEqual([]); return (await env.DB.prepare('SELECT reminder_id, due_datetime, content FROM reminder_projections WHERE due_at IS NOT NULL').all()).results; }

describe('authoritative projections and file revisions', () => {
	it('keeps a recreated same-content file when an earlier delete is retried', async () => {
		const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'note.md', 'same', null);
		const prior = await getStoredFileRow(env.DB, 'note.md');
		const request = () => new Request('https://test/sync/batch-delete', { method: 'POST', body: JSON.stringify({ files: [{ path: 'note.md', expectedHash: first.hash, expectedRevision: prior?.storageKey }] }) });
		expect(await (await handleBatchDelete(request(), env.BUCKET, env.DB)).json()).toMatchObject({ deleted: ['note.md'] });
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'note.md', 'same', null);
		expect(await (await handleBatchDelete(request(), env.BUCKET, env.DB)).json()).toMatchObject({ deleted: [], errors: [{ path: 'note.md', status: 409 }] });
		expect(await getStoredFileRow(env.DB, 'note.md')).not.toBeNull();
	});
	it('records projection intent even when a file commit response is lost', async () => {
		await configure();
		const batch = env.DB.batch.bind(env.DB);
		vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('lost'); });
		await expect(writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null)).rejects.toThrow('lost');
		await drainNotificationProjections(env);
		expect(await jobs()).toMatchObject([{ reminder_id: '11111111-1111-4111-8111-111111111111', due_datetime: '2099-01-02T10:00:00.000Z' }]);
	});
	it('projects the latest committed reminder after multiple updates and a deletion', async () => {
		await configure();
		const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note.replace('Due', 'New title'), first.hash);
		await drainNotificationProjections(env);
		expect(await jobs()).toMatchObject([{ content: 'New title' }]);
		const file = await getStoredFileRow(env.DB, 'Reminders/Inbox.md');
		await handleBatchDelete(new Request('https://test/sync/batch-delete', { method: 'POST', body: JSON.stringify({ files: [{ path: 'Reminders/Inbox.md', expectedHash: file?.hash, expectedRevision: file?.storageKey }] }) }), env.BUCKET, env.DB);
		await drainNotificationProjections(env);
		expect(await jobs()).toEqual([]);
	});
	it('does not allow startup on another device to replace the saved timezone policy', async () => {
		await configure();
		const response = await handleNotificationPolicy(new Request('https://test/reminders/notification-policy', { method: 'POST', body: JSON.stringify({ ...policy, timezone: 'Asia/Tokyo', allDayTime: null }) }), env.DB);
		expect(await response.json()).toMatchObject({ policy: { timezone: 'America/New_York', allDayTime: '09:00' } });
		expect(notificationDatetime({ dueDate: '2027-03-14' }, policy)).toBe('2027-03-14T13:00:00.000Z');
	});
});

it('defers delivery while its committed source revision awaits projection', async () => {
	await configure();
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
	await drainNotificationProjections(env);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note.replace('Due', 'Latest'), first.hash);
	await env.DB.prepare('UPDATE reminder_projections SET due_at = ?').bind(Date.now()).run();
	const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await deliverDueReminders(env)).toBeGreaterThan(Date.now());
	logged.mockRestore();
	expect(await env.DB.prepare('SELECT content, attempts FROM reminder_projections').first()).toMatchObject({ content: 'Due', attempts: 1 });
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT content FROM reminder_projections').first()).toMatchObject({ content: 'Latest' });
});
it('does not continuously wake a coordinator before a notification policy is configured', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
	const setAlarm = vi.fn();
	await runNotificationCoordinator({ storage: { setAlarm } } as never, env);
	expect(setAlarm).not.toHaveBeenCalled();
});
it('disables all derived schedules through an explicit policy revision', async () => {
	await configure();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
	await drainNotificationProjections(env);
	const current = await env.DB.prepare('SELECT revision FROM notification_policy').first<{ revision: string }>();
	expect((await handleNotificationPolicy(new Request('https://test/policy', { method: 'PUT', body: JSON.stringify({ ...policy, enabled: false, expectedRevision: current!.revision }) }), env.DB)).status).toBe(200);
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT due_datetime, due_at FROM reminder_projections').first()).toEqual({ due_datetime: null, due_at: null });
});
