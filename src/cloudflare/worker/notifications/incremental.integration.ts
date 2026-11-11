/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleNotificationPolicy } from './policy';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { drainNotificationProjections } from './projection';
import { notificationAuthority } from '../reminders/source-state';
import { runNotificationCoordinator } from './coordinator';

const path = 'Reminders/Inbox.md';
const due = '2099-01-01T12:00:00.000Z';
const note = (id: string, title = 'Task', date = due) => `- [ ] ${title}${date ? ` ${date}` : ''} <!-- crate-id:${id} -->`;
beforeEach(async () => {
	await applySchema(env.DB);
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({
		folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00',
	}) }), env.DB);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const schedules = async () => (await env.DB.prepare(`SELECT reminder_id, notification_token, due_datetime, content, due_at, attempts, last_error
  FROM reminder_projections ORDER BY reminder_id`).all<Record<string, unknown>>()).results;
const scheduled = async () => (await schedules()).filter(row => row.due_at !== null);

it('edits one schedule without rewriting its eleven unchanged neighbors', async () => {
	const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
	const content = ids.map(id => note(id)).join('\n');
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await drainNotificationProjections(env);
	const original = await schedules();
	expect(original).toHaveLength(12);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace(note(ids[0]!), note(ids[0]!, 'Changed')), first.hash);
	await drainNotificationProjections(env);
	const after = await schedules();
	expect(after.filter(row => row.reminder_id !== ids[0])).toEqual(original.filter(row => row.reminder_id !== ids[0]));
	expect(after.find(row => row.reminder_id === ids[0])).toMatchObject({ content: 'Changed', due_at: Date.parse(due) });
	const authorized = await notificationAuthority(env.DB, after.map(row => ({ id: String(row.reminder_id), token: String(row.notification_token), filePath: path })));
	expect(authorized.size).toBe(12);
});

it('preserves neighbors and their retry deadlines when another reminder changes', async () => {
	const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
	const content = ids.map(id => note(id)).join('\n');
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await drainNotificationProjections(env);
	await env.DB.prepare('UPDATE reminder_projections SET attempts = 3, due_at = ?, last_error = ?').bind(Date.now() + 60_000, 'temporary').run();
	const before = await schedules();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace(note(ids[0]!), note(ids[0]!).replace('[ ]', '[x]')), first.hash);
	await drainNotificationProjections(env);
	const after = await schedules();
	expect(after.filter(row => row.reminder_id !== ids[0])).toEqual(before.filter(row => row.reminder_id !== ids[0]));
	expect(after.find(row => row.reminder_id === ids[0])).toMatchObject({ due_datetime: null, due_at: null, attempts: 0, last_error: null });
});

it('schedules just one reminder when adding a date among 400 previously projected undated reminders', async () => {
	const ids = Array.from({ length: 400 }, () => crypto.randomUUID());
	const content = ids.map(id => note(id, 'Task', '')).join('\n');
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await drainNotificationProjections(env);
	expect(await scheduled()).toEqual([]);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace(note(ids[0]!, 'Task', ''), note(ids[0]!)), first.hash);
	await drainNotificationProjections(env);
	expect(await scheduled()).toMatchObject([{ reminder_id: ids[0], due_datetime: due }]);
});

it('repairs a schedule missing from its projection row on the next projection', async () => {
	const content = note(crypto.randomUUID());
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await drainNotificationProjections(env);
	await env.DB.prepare('UPDATE reminder_projections SET due_datetime = NULL, content = NULL, due_at = NULL').run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content + '\nUnrelated note', first.hash);
	await drainNotificationProjections(env);
	expect(await scheduled()).toMatchObject([{ content: 'Task', due_at: Date.parse(due) }]);
});

it('reports schedule writes to the dispatcher and leaves due times off the coordinator alarm', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note(crypto.randomUUID()), null);
	const setAlarm = vi.fn();
	const state = { storage: { setAlarm } } as never;
	expect(await runNotificationCoordinator(state, env)).toEqual({ wrote: true, dispatchAt: Date.parse(due) });
	expect(await runNotificationCoordinator(state, env)).toEqual({ wrote: false, dispatchAt: Date.parse(due) });
	expect(setAlarm).not.toHaveBeenCalledWith(Date.parse(due));
});

it('does not reschedule a delivered occurrence on unrelated edits', async () => {
	const id = crypto.randomUUID();
	const content = note(id);
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await drainNotificationProjections(env);
	await env.DB.prepare('UPDATE reminder_projections SET due_at = NULL, delivered_due = due_datetime').run();
	const second = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, `${content}\nUnrelated note`, first.hash);
	await drainNotificationProjections(env);
	expect(await scheduled()).toEqual([]);
	const snoozed = '2099-01-03T12:00:00.000Z';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note(id, 'Task', snoozed), second.hash);
	await drainNotificationProjections(env);
	expect(await scheduled()).toMatchObject([{ reminder_id: id, due_datetime: snoozed, due_at: Date.parse(snoozed) }]);
});

it('keeps a reminder scheduled when it moves to another note projected in the same pass', async () => {
	const id = crypto.randomUUID(), other = crypto.randomUUID();
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', `${note(id)}\n${note(other)}`, null);
	await drainNotificationProjections(env);
	expect(await scheduled()).toHaveLength(2);
	// Both notes' jobs run in one pass: A's departure must not remove B's schedule.
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', note(other), first.hash);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/B.md', note(id), null);
	await drainNotificationProjections(env, 8);
	expect(await env.DB.prepare('SELECT file_path, due_at FROM reminder_projections WHERE reminder_id = ?').bind(id).first())
		.toEqual({ file_path: 'Reminders/B.md', due_at: Date.parse(due) });
});
