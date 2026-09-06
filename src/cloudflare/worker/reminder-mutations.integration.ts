/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { handleCreateReminder } from './reminders-web/routes/create';
import { handleUpdateReminder } from './reminders-web/routes/update';
import { handleSetReminderCompleted } from './reminders-web/routes/complete';
import { handleDeleteReminder } from './reminders-web/routes/delete';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { scanReminderMarkdownFile } from './reminders-web/scan';
import type { ReminderRecord } from '@/pwa/types';

const path = 'Reminders/Inbox.md';
const request = (body: Record<string, unknown>) => new Request('https://test/reminders', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', allDayNotificationTime: null, ...body }) });
const createBody = () => ({ id: crypto.randomUUID(), operationId: crypto.randomUUID(), content: 'Task', project: 'Inbox' });
const { DB: db, BUCKET: bucket } = env;
beforeEach(async () => { for (const sql of schemaSql.split(';').map(sql => sql.trim()).filter(Boolean)) await db.prepare(sql).run(); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function payload(response: Response) { expect(response.status, await response.clone().text()).toBe(200); return (await response.json()) as { reminder: ReminderRecord }; }
async function records() { return scanReminderMarkdownFile(path, (await readCommittedMarkdownFileVersion(bucket, db, path))!.content, 'Reminders'); }
function loseCommit() { const batch = db.batch.bind(db); vi.spyOn(db, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('Lost commit response'); }); }

describe('transactional reminder retries and revisions', () => {
	it('replays a committed create after a lost response without appending twice', async () => {
		const body = createBody(); loseCommit();
		await expect(handleCreateReminder(request(body), env)).rejects.toThrow('Lost commit response');
		const result = await payload(await handleCreateReminder(request(body), env));
		expect(result.reminder.id).toBe(body.id);
		expect(await records()).toHaveLength(1);
		expect((await handleCreateReminder(request({ ...body, operationId: crypto.randomUUID() }), env)).status).toBe(409);
	});
	it('rejects old whole-form edits after a plugin changes the same reminder', async () => {
		const { reminder } = await payload(await handleCreateReminder(request(createBody()), env));
		const file = (await readCommittedMarkdownFileVersion(bucket, db, path))!;
		await writeCommittedMarkdownFile(bucket, db, path, file.content.replace('Task', 'Changed in Obsidian'), file.hash);
		const response = await handleUpdateReminder(request({ id: reminder.id, operationId: crypto.randomUUID(), filePath: path, expectedRevision: reminder.revision, content: 'Stale PWA title' }), env);
		expect(response.status).toBe(409);
		expect((await records())[0]?.content).toBe('Changed in Obsidian');
	});
	it('returns a mismatched operation receipt only within its authorized folder', async () => {
		const body = createBody();
		const { reminder } = await payload(await handleCreateReminder(request(body), env));
		const retry = await handleCreateReminder(request({ ...body, content: 'Edited after an uncertain save' }), env);
		expect(retry.status).toBe(409);
		expect(await retry.json()).toMatchObject({ code: 'operation_mismatch', committedReminder: reminder });
		for (const folderPath of ['Private', 'Reminder', 'Reminders/Nested']) {
			const outside = await handleCreateReminder(request({ ...body, folderPath }), env);
			expect(outside.status).toBe(409);
			expect(await outside.json()).not.toHaveProperty('committedReminder');
		}
		expect(await records()).toHaveLength(1);
	});
	it('replays recurring completion without advancing a second occurrence, including after a move', async () => {
		const { reminder } = await payload(await handleCreateReminder(request({ ...createBody(), dueDatetime: '2099-01-01T09:00:00Z', recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0 } }), env));
		const body = { id: reminder.id, filePath: path, expectedRevision: reminder.revision, operationId: crypto.randomUUID(), completed: true };
		loseCommit();
		await expect(handleSetReminderCompleted(request(body), env)).rejects.toThrow('Lost commit response');
		const first = await payload(await handleSetReminderCompleted(request(body), env));
		expect(first.reminder.dueDatetime).toBe('2099-01-02T09:00:00.000Z');
		await payload(await handleUpdateReminder(request({ id: reminder.id, filePath: path, expectedRevision: first.reminder.revision, operationId: crypto.randomUUID(), project: 'Work' }), env));
		const replay = await payload(await handleSetReminderCompleted(request(body), env));
		expect(replay).toEqual(first);
		expect(await records()).toHaveLength(0);
	});
	it('replays delete without deleting a subsequent reminder, and rejects operation ID reuse', async () => {
		const body = createBody();
		const { reminder } = await payload(await handleCreateReminder(request(body), env));
		const deletion = { id: reminder.id, filePath: path, expectedRevision: reminder.revision, operationId: crypto.randomUUID() };
		expect((await handleDeleteReminder(request(deletion), env)).status).toBe(200);
		await payload(await handleCreateReminder(request(createBody()), env));
		expect((await handleDeleteReminder(request(deletion), env)).status).toBe(200);
		expect(await records()).toHaveLength(1);
		expect((await handleCreateReminder(request({ ...body, content: 'Different request' }), env)).status).toBe(409);
	});
});
