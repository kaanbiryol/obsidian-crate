import { createReminderOperationId } from '@/protocol/reminder-operation';
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { writeCommittedMarkdownFile } from './storage';
import { handleListReminders } from './reminders-web/routes/list';
import { handleUpdateReminder } from './reminders-web/routes/update';
import { handleNotificationPolicy } from './notification-policy';
import { drainNotificationProjections } from './notification-projection';
import { normalizeReminderScheduleLine } from '@/reminders/core/normalizeReminderSchedule';
import type { ReminderRecord } from '@/pwa/types';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await reset(); });
const path = 'Reminders/Inbox.md';
const text = '- [ ] Send invoice tomorrow <!-- crate-id:invoice -->';
const request = () => new Request('https://test/reminders/list?folderPath=Reminders');
function clock(date: string) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(date)); }

it('keeps cached list revisions valid for a fresh mutation after midnight', async () => {
	clock('2026-09-08T10:00:00Z');
	const canonical = normalizeReminderScheduleLine(text);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, canonical, null);
	const first = await handleListReminders(request(), env);
	const etag = first.headers.get('ETag')!;
	const initial = await first.json() as { reminders: ReminderRecord[] };
	expect(initial.reminders[0]!.dueDate).toBe('2026-09-09');
	clock('2026-09-09T10:00:00Z');
	const conditional = await handleListReminders(new Request(request(), { headers: { 'If-None-Match': etag } }), env);
	expect(conditional.status).toBe(304);
	const response = await handleUpdateReminder(new Request('https://test/reminders/update', {
		method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', id: 'invoice', filePath: path,
			operationId: newOperationId(), expectedRevision: initial.reminders[0]!.revision, content: 'Updated invoice' }),
	}), env);
	expect(response.status).toBe(200);
	const updated = await handleListReminders(request(), env);
	expect(await updated.json()).toMatchObject({ reminders: [{ content: 'Updated invoice', dueDate: '2026-09-09' }] });
});

it('projects an adopted schedule after midnight using the same committed due key', async () => {
	clock('2026-09-08T10:00:00Z');
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, normalizeReminderScheduleLine(text), null);
	expect(await env.DB.prepare('SELECT due_key FROM reminder_sources WHERE reminder_id = ?').bind('invoice').first()).toMatchObject({ due_key: '2026-09-09' });
	clock('2026-09-09T00:01:00Z');
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT last_error FROM notification_projection_jobs WHERE path = ?').bind(path).first()).toBeNull();
	const job = await env.DB.prepare('SELECT reminder_id, payload_json FROM notification_jobs').first<{ reminder_id: string; payload_json: string }>();
	expect(job?.reminder_id).toBe('invoice');
	expect(JSON.parse(job!.payload_json)).toMatchObject({ dueDatetime: '2026-09-09T09:00:00.000Z' });
});

it('preserves raw ambiguous bytes as an issue until Obsidian saves an explicit schedule', async () => {
	clock('2026-09-08T10:00:00Z');
	const committed = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, text, null);
	const first = await handleListReminders(request(), env);
	const unresolved = await first.json() as { reminders: ReminderRecord[]; issues: Array<{ message: string }> };
	expect(unresolved.reminders).toEqual([]);
	expect(JSON.stringify(unresolved.issues)).toContain('explicit date and timezone');
	expect(await env.DB.prepare('SELECT * FROM reminder_sources WHERE reminder_id = ?').bind('invoice').first()).toBeNull();
	clock('2026-09-09T10:00:00Z');
	expect(await (await handleListReminders(request(), env)).json()).toEqual(unresolved);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, normalizeReminderScheduleLine(text), committed.hash);
	const fixed = await handleListReminders(request(), env);
	expect(await fixed.json()).toMatchObject({ reminders: [{ id: 'invoice', dueDate: '2026-09-10' }], issues: [] });
});

const issuedDay = Math.floor(Date.now() / 86_400_000);
function newOperationId() { return createReminderOperationId(issuedDay); }
