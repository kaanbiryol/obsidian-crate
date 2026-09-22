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
import { parseReminderEditorContent } from '@/reminders/utils/reminderEditorParsing';
import { calculateNextOccurrence } from '@/reminders/utils/recurrenceCalculator';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await reset(); });
const path = 'Reminders/Inbox.md';
const text = '- [ ] Send invoice tomorrow <!-- crate-id:invoice -->';
const request = () => new Request('https://test/reminders/list?folderPath=Reminders');
function clock(date: string) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(date)); }

it.each([
  ['Notes from Monday', undefined],
  ['Notes from Friday', undefined],
  ['Notes from Monday', '2026-09-25T09:00:00.000Z'],
  ['Notes from Friday', '2026-09-25T09:00:30.123Z'],
])('preserves weekday title text through API storage, revalidation and editing: %s %s', async (content, dueDatetime) => {
  const operationId = newOperationId();
  const dates = { dueDate: '2026-09-25', ...(dueDatetime ? { dueDatetime } : {}) };
  const created = await handleCreateReminder(new Request('https://test/create', { method: 'POST', body: JSON.stringify({
    id: operationId, operationId, folderPath: 'Reminders', project: 'Inbox', content, priority: 4, ...dates,
  }) }), env);
  expect(created.status).toBe(200);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1).run();
  await revalidateReminderSources(env, 3);
  const listed = await (await handleListReminders(request(), env)).json() as { reminders: ReminderRecord[]; issues: unknown[] };
  expect(listed.issues).toEqual([]);
  expect(listed.reminders).toHaveLength(1);
  expect(listed.reminders[0]).toMatchObject({ content, ...dates });
  const updated = await handleUpdateReminder(new Request('https://test/update', { method: 'POST', body: JSON.stringify({
    folderPath: 'Reminders', id: operationId, filePath: path, operationId: newOperationId(),
    expectedRevision: listed.reminders[0]!.revision, content: `Edited ${content}`, priority: 1,
  }) }), env);
  expect(updated.status).toBe(200);
  expect(await (await handleListReminders(request(), env)).json()).toMatchObject({
    reminders: [{ content: `Edited ${content}`, priority: 1, ...dates }], issues: [],
  });
});

it.each(['Sep 25, 2026', '2026-09-25T09:00:30.123Z'])('retains the title in existing Markdown on revalidation: %s', async schedule => {
  const raw = `- [ ] Notes from Monday ${schedule} <!-- crate-id:existing -->`;
  expect(normalizeReminderScheduleLine(raw)).toBe(raw);
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, raw, null);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1).run();
  await revalidateReminderSources(env, 3);
  expect(await (await handleListReminders(request(), env)).json()).toMatchObject({
    reminders: [{ content: 'Notes from Monday', dueDate: '2026-09-25' }], issues: [],
  });
  const file = await env.DB.prepare('SELECT storage_key FROM files WHERE path = ?').bind(path).first<{ storage_key: string }>();
  expect(await (await env.BUCKET.get(file!.storage_key))!.text()).toBe(raw);
});

it.each([
  ['Friday 09:00 UTC', '2026-09-25T09:00:00.000Z'],
  ['2026-09-25T09:00:30.123-03:30', '2026-09-25T12:30:30.123Z'],
])('preserves a range endpoint through create, source revalidation and update: %s', async (endpoint, dueDatetime) => {
  clock('2026-09-21T13:00:37.123Z');
  const parsed = parseReminderEditorContent(`Compare Monday to ${endpoint}`);
  expect(parsed).toMatchObject({ cleanContent: 'Compare Monday to', dueDate: new Date(dueDatetime), dateError: undefined });
  const operationId = newOperationId();
  const created = await handleCreateReminder(new Request('https://test/create', { method: 'POST', body: JSON.stringify({
    id: operationId, operationId, folderPath: 'Reminders', project: 'Inbox', content: parsed.cleanContent,
    priority: 4, dueDatetime: parsed.dueDate!.toISOString(),
  }) }), env);
  expect(created.status).toBe(200);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1).run();
  await revalidateReminderSources(env, 3);
  const listed = await (await handleListReminders(request(), env)).json() as { reminders: ReminderRecord[]; issues: unknown[] };
  expect(listed.issues).toEqual([]);
  expect(listed.reminders).toHaveLength(1);
  expect(listed.reminders[0]).toMatchObject({ content: 'Compare Monday to', dueDatetime });
  const updated = await handleUpdateReminder(new Request('https://test/update', { method: 'POST', body: JSON.stringify({
    folderPath: 'Reminders', id: operationId, filePath: path, operationId: newOperationId(),
    expectedRevision: listed.reminders[0]!.revision, content: 'Edited Monday to',
  }) }), env);
  expect(updated.status).toBe(200);
  expect(await (await handleListReminders(request(), env)).json()).toMatchObject({
    reminders: [{ content: 'Edited Monday to', dueDatetime }], issues: [],
  });
  const file = await env.DB.prepare('SELECT storage_key FROM files WHERE path = ?').bind(path).first<{ storage_key: string }>();
  const raw = await (await env.BUCKET.get(file!.storage_key))!.text();
  expect(raw).toContain(`- [ ] Edited Monday to ${dueDatetime} <!-- crate-id:${operationId} -->`);
  expect(normalizeReminderScheduleLine(raw.trim())).toBe(raw.trim());
});

it.each([
  ['Europe/Berlin', '2026-03-28T08:00:30.123Z', '2026-03-29T07:00:30.123Z', '09:00:30.123'],
  ['-03:30', '2026-03-28T12:30:30.123Z', '2026-03-29T12:30:30.123Z', '09:00:30.123'],
  ['Europe/Berlin', '2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z'],
  ['+05:30', '2026-03-28T03:30:00.000Z', '2026-03-29T03:30:00.000Z'],
  ['-03:30', '2026-03-28T12:30:00.000Z', '2026-03-29T12:30:00.000Z'],
  ['Europe/Berlin', '2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z', 'at 9 in the morning'],
  ['+05:30', '2026-03-28T03:30:00.000Z', '2026-03-29T03:30:00.000Z', "at 9 o'clock"],
])('preserves a typed recurrence zone %s through API storage and source revalidation', async (zone, dueDatetime, next, time = '09:00') => {
  const operationId = newOperationId();
  const recurrence = parseReminderEditorContent(`Task daily ${time} ${zone}`).recurrence!;
  expect(calculateNextOccurrence(new Date(dueDatetime), recurrence)?.toISOString()).toBe(next);
  const created = await handleCreateReminder(new Request('https://test/create', { method: 'POST', body: JSON.stringify({
    id: operationId, operationId, folderPath: 'Reminders', project: 'Inbox', content: 'Task', priority: 4, dueDatetime, recurrence,
  }) }), env);
  expect(created.status).toBe(200);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1).run();
  await revalidateReminderSources(env, 3);
  const listed = await (await handleListReminders(request(), env)).json() as { reminders: ReminderRecord[]; issues: unknown[] };
  expect(listed.issues).toEqual([]);
  expect(listed.reminders[0]).toMatchObject({ content: 'Task', recurrence, dueDatetime });
  expect(calculateNextOccurrence(new Date(listed.reminders[0]!.dueDatetime!), listed.reminders[0]!.recurrence!)?.toISOString()).toBe(next);
});

it.each(['Compare Monday with', 'Review weekly report', 'Task every Monday', 'Compare #Home with'])('keeps inactive schedule text through create and revalidation: %s', async content => {
  const operationId = newOperationId();
  const created = await handleCreateReminder(new Request('https://test/create', { method: 'POST', body: JSON.stringify({
    id: operationId, operationId, folderPath: 'Reminders', project: 'Inbox', content, priority: 4, dueDate: '2099-01-01',
  }) }), env);
  expect(created.status).toBe(200);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1).run();
  await revalidateReminderSources(env, 3);
  const result = await (await handleListReminders(request(), env)).json() as { reminders: ReminderRecord[]; issues: unknown[] };
  expect(result.issues).toEqual([]);
  expect(result.reminders).toHaveLength(1);
  expect(result.reminders[0]).toMatchObject({ content, dueDate: '2099-01-01' });
  expect(result.reminders[0]?.recurrence).toBeUndefined();
});

it.each(['2026-02-30T09:00:00Z', '2026-13-01T09:00:00Z'])('keeps a timestamp Chrono does not recognize as unscheduled text: %s', async date => {
  const raw = `- [ ] Task ${date} <!-- crate-id:invalid -->`;
  const committed = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, raw, null);
  const result = await (await handleListReminders(request(), env)).json() as { reminders: ReminderRecord[]; issues: unknown[] };
  expect(result.reminders).toHaveLength(1);
  expect(result.reminders[0]).toMatchObject({ content: `Task ${date}` });
  expect(result.reminders[0]?.dueDatetime).toBeUndefined();
  expect(result.reminders[0]?.dueDate).toBeUndefined();
  expect(result.issues).toEqual([]);
  expect(await env.DB.prepare('SELECT * FROM reminder_sources WHERE reminder_id = ? AND due_key IS NOT NULL').bind('invalid').first()).toBeNull();
  const file = await env.DB.prepare('SELECT storage_key FROM files WHERE path = ? AND hash = ?').bind(path, committed.hash).first<{ storage_key: string }>();
  expect(await (await env.BUCKET.get(file!.storage_key))!.text()).toBe(raw);
});

it.each(['Email monday@example.com', 'Review monday.com', 'Open /notes/Friday.md', 'Review 31.04.2027.pdf',
  'Task 2026-02-30', 'Task February 30 09:00', 'Task 29 February 2026 09:00', 'Task 02/30/2027 09:00',
  'Task 31/04/2027 09:00', 'Task 2027/02/29 09:00', 'Task 31.04.2027 09:00', 'Task 04-31-2027 09:00', 'Task 2027-2-30 09:00',
  'Task February 30 at 9 in the morning', 'Task 2027-02-29 at noon',
  'Task 2026-02-30T09:00:00Z', 'Task 2026-13-01T09:00:00Z'])('keeps unscheduled text through create and revalidation: %s', async content => {
  const operationId = newOperationId();
  const created = await handleCreateReminder(new Request('https://test/create', { method: 'POST', body: JSON.stringify({
    id: operationId, operationId, folderPath: 'Reminders', project: 'Inbox', content, priority: 4,
  }) }), env);
  expect(created.status).toBe(200);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1).run();
  await revalidateReminderSources(env, 3);
  const result = await (await handleListReminders(request(), env)).json() as { reminders: ReminderRecord[]; issues: unknown[] };
  expect(result.issues).toEqual([]);
  expect(result.reminders).toHaveLength(1);
  expect(result.reminders[0]?.content).toBe(content);
  expect(result.reminders[0]?.dueDate).toBeUndefined();
  expect(result.reminders[0]?.dueDatetime).toBeUndefined();
  expect(result.reminders[0]?.recurrence).toBeUndefined();
});

it.each(['[Weekly report](https://example.com/report)', '[Review ! #work](https://example.com/report)'])('preserves %s through create, cache upgrade and source revalidation', async content => {
  await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
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
