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
import { revalidateReminderSources } from '../reminders/source-migration';
import { REMINDER_CACHE_PARSER_VERSION } from '../reminders/cache/types';

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
const schedules = async () => (await env.DB.prepare(`SELECT reminder_id, notification_token, due_datetime, content, due_at, attempts, delivery_failed_at
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
	await env.DB.prepare('UPDATE reminder_projections SET attempts = 3, due_at = ?').bind(Date.now() + 60_000).run();
	const before = await schedules();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace(note(ids[0]!), note(ids[0]!).replace('[ ]', '[x]')), first.hash);
	await drainNotificationProjections(env);
	const after = await schedules();
	expect(after.filter(row => row.reminder_id !== ids[0])).toEqual(before.filter(row => row.reminder_id !== ids[0]));
	expect(after.find(row => row.reminder_id === ids[0])).toMatchObject({ due_datetime: null, due_at: null, attempts: 0 });
});

it('repairs a projection row that no longer matches its note when the parser is upgraded', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note(crypto.randomUUID()), null);
	await drainNotificationProjections(env);
	await env.DB.prepare('UPDATE reminder_projections SET due_datetime = NULL, content = NULL, due_at = NULL').run();
	// A parser upgrade re-reads the note; its snapshot alone would still match.
	await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ? WHERE file_path = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1, path).run();
	while (await revalidateReminderSources(env, 10)) { /* drain the upgrade */ }
	await drainNotificationProjections(env, 8);
	expect(await scheduled()).toMatchObject([{ content: 'Task', due_at: Date.parse(due) }]);
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

it('repairs a schedule missing from its projection row once another note shares its identities', async () => {
	const id = crypto.randomUUID();
	const content = note(id);
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await drainNotificationProjections(env);
	await env.DB.prepare('UPDATE reminder_projections SET due_datetime = NULL, content = NULL, due_at = NULL').run();
	// The note's snapshot still describes the schedule, so an unrelated edit reads no row.
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content + '\nUnrelated note', first.hash);
	await drainNotificationProjections(env);
	expect(await scheduled()).toEqual([]);
	// A note that takes and then drops the identity makes this one check every reminder again.
	const other = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Other.md', note(id), null);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Other.md', 'No reminders', other.hash);
	await drainNotificationProjections(env, 8);
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

it('writes rows only for scheduled reminders and keeps a row whose reminder loses its date', async () => {
	const [dated, undated, other] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, [note(dated), note(undated, 'Task', ''), note(other, 'Task', '')].join('\n'), null);
	await drainNotificationProjections(env);
	expect((await schedules()).map(row => row.reminder_id)).toEqual([dated]);
	// Losing the date clears the schedule in place; gaining one adds the only new row.
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, [note(dated, 'Task', ''), note(undated), note(other, 'Task', '')].join('\n'), first.hash);
	await drainNotificationProjections(env);
	const rows = new Map((await schedules()).map(row => [row.reminder_id, row]));
	expect(rows.size).toBe(2);
	expect(rows.get(dated)).toMatchObject({ due_datetime: null, due_at: null });
	expect(rows.get(undated)).toMatchObject({ due_datetime: due, due_at: Date.parse(due) });
});

it('keeps a delivered occurrence when its reminder moves to another note', async () => {
	const id = crypto.randomUUID();
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', `${note(id)}\n${note(crypto.randomUUID(), 'Task', '')}`, null);
	await drainNotificationProjections(env);
	await env.DB.prepare('UPDATE reminder_projections SET due_at = NULL, delivered_due = due_datetime').run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', 'Moved away', first.hash);
	await drainNotificationProjections(env, 8);
	expect(await env.DB.prepare('SELECT file_path, delivered_due FROM reminder_projections WHERE reminder_id = ?').bind(id).first())
		.toEqual({ file_path: null, delivered_due: due });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/B.md', note(id), null);
	await drainNotificationProjections(env, 8);
	expect(await env.DB.prepare('SELECT file_path, due_at, delivered_due FROM reminder_projections WHERE reminder_id = ?').bind(id).first())
		.toEqual({ file_path: 'Reminders/B.md', due_at: null, delivered_due: due });
});

it('quarantines a projected note when another note takes one of its identities, and resumes it after', async () => {
	const id = crypto.randomUUID();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', `${note(id)}\n${note(crypto.randomUUID())}`, null);
	await drainNotificationProjections(env);
	const copy = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/B.md', note(id, 'Copy'), null);
	// In separate passes, so A's own pass must find the duplicate though the identity is not new to it.
	await drainNotificationProjections(env, 1);
	await drainNotificationProjections(env, 1);
	const jobs = await env.DB.prepare('SELECT path, last_error FROM notification_projection_jobs ORDER BY path').all<{ path: string; last_error: string | null }>();
	expect(jobs.results.map(job => [job.path, job.last_error?.startsWith('Duplicate reminder identifiers')]))
		.toEqual([['Reminders/A.md', true], ['Reminders/B.md', true]]);
	// The pending job withholds the projected note's delivery authority.
	const rows = await schedules();
	expect((await notificationAuthority(env.DB, rows.map(row => ({ id: String(row.reminder_id), token: String(row.notification_token), filePath: 'Reminders/A.md' })))).size).toBe(0);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/B.md', 'No reminders', copy.hash);
	await drainNotificationProjections(env, 8);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_projection_jobs').first()).toEqual({ n: 0 });
	expect(await scheduled()).toHaveLength(2);
});
