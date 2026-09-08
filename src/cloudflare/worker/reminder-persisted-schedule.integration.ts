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
import { handleCreateReminder } from './reminders-web/routes/create';
import { revalidateReminderSources } from './reminder-source-migration';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await reset(); });
const path = 'Reminders/Inbox.md';
const text = '- [ ] Send invoice tomorrow <!-- crate-id:invoice -->';
const request = () => new Request('https://test/reminders/list?folderPath=Reminders');
function clock(date: string) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(date)); }

it.each(['[Weekly report](https://example.com/report)', '[Review ! #work](https://example.com/report)'])('preserves %s through create, cache upgrade and source revalidation', async content => {
	const operationId = newOperationId();
	const dueDatetime = '2099-01-01T09:00:00.000Z';
	const recurrence = { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0 };
	const created = await handleCreateReminder(new Request('https://test/create', { method: 'POST', body: JSON.stringify({
		id: operationId, operationId, folderPath: 'Reminders', project: 'Inbox', content, priority: 4, dueDatetime, recurrence,
	}) }), env);
	expect(created.status).toBe(200);
	expect(await created.json()).toMatchObject({ reminder: { id: operationId, content, priority: 4, dueDatetime, recurrence } });
	const file = await env.DB.prepare('SELECT storage_key, hash FROM files WHERE path = ?').bind(path).first<{ storage_key: string; hash: string }>();
	const bytes = await (await env.BUCKET.get(file!.storage_key))!.text();
	// Parser 6 could quarantine this file or save a title/priority derived from
	// literal link text. Neither disposable cache nor durable authority is reused.
	await env.DB.prepare("UPDATE reminder_file_cache SET parser_version = 6, reminders_json = '[]'").run();
	await env.DB.prepare('UPDATE reminder_source_state SET parser_version = 6, verified = 0').run();
	await revalidateReminderSources(env, 3);
	expect(await (await handleListReminders(request(), env)).json()).toMatchObject({ reminders: [{ content, priority: 4, dueDatetime, recurrence }], issues: [] });
	expect(await env.DB.prepare('SELECT verified, parser_version FROM reminder_source_state WHERE file_path = ?').bind(path).first()).toEqual({ verified: 1, parser_version: REMINDER_CACHE_PARSER_VERSION });
	expect(await env.DB.prepare('SELECT parser_version FROM reminder_file_cache WHERE file_path = ?').bind(path).first()).toEqual({ parser_version: REMINDER_CACHE_PARSER_VERSION });
	expect(await env.DB.prepare('SELECT due_key FROM reminder_sources WHERE reminder_id = ?').bind(operationId).first()).toEqual({ due_key: dueDatetime });
	expect(await (await env.BUCKET.get(file!.storage_key))!.text()).toBe(bytes);
});

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
