/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createReminderOperationId, REMINDER_RETRY_DAYS } from '@/protocol/reminder-operation';
import { beginReminderOperation } from './reminders-web/operations';
import { handleCreateReminder } from './reminders-web/routes/create';
import { handleSetReminderCompleted } from './reminders-web/routes/complete';
import { handleUpdateReminder } from './reminders-web/routes/update';
import { pruneReminderOperations } from './maintenance/reminder-history';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import type { ReminderRecord } from '@/pwa/types';

const { DB: db, BUCKET: bucket } = env;
const path = 'Reminders/Inbox.md';
let day: number;
beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(sql).run();
	day = (await db.prepare("SELECT CAST(unixepoch('now') / 86400 AS INTEGER) AS day").first<{ day: number }>())!.day;
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const request = (body: Record<string, unknown>) => new Request('https://test/reminders', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', ...body }) });
async function payload(response: Response) {
	expect(response.status, await response.clone().text()).toBe(200);
	return await response.json() as { reminder: ReminderRecord };
}
async function setFloor(floor: number) {
	await db.prepare("INSERT OR REPLACE INTO maintenance_state (key, value) VALUES ('reminder_operation_floor', ?)").bind(String(floor)).run();
}

it('accepts the last valid day and refuses expired, future and missing legacy commands before touching R2', async () => {
	const validDay = day - REMINDER_RETRY_DAYS + 1;
	const id = createReminderOperationId(validDay);
	await payload(await handleCreateReminder(request({ id, operationId: id, content: 'Boundary task' }), env));
	// Retention follows the encoded retry window, not a misleading receipt date.
	await db.prepare("UPDATE reminder_operations SET created_at = '2000-01-01 00:00:00'").run();
	await pruneReminderOperations(db);
	expect(await db.prepare('SELECT operation_id FROM reminder_operations').first()).toEqual({ operation_id: id });
	const put = vi.spyOn(bucket, 'put');
	for (const expiredId of [createReminderOperationId(validDay - 1), createReminderOperationId(day + 1), crypto.randomUUID()]) {
		const response = await handleCreateReminder(request({ id: expiredId, operationId: expiredId, content: 'Never append' }), env);
		expect(response.status).toBe(410);
		expect(await response.json()).toMatchObject({ code: 'operation_expired' });
	}
	expect(put).not.toHaveBeenCalled();
});

it('cannot recreate a pruned reminder identity through either an exact retry or a new command', async () => {
	const issued = day - REMINDER_RETRY_DAYS + 1;
	const id = createReminderOperationId(issued);
	const body = { id, operationId: id, content: 'Create once' };
	await payload(await handleCreateReminder(request(body), env));
	const file = (await readCommittedMarkdownFileVersion(bucket, db, path))!;
	await writeCommittedMarkdownFile(bucket, db, path, '# Inbox\n', file.hash);
	await setFloor(issued + 1);
	await pruneReminderOperations(db);
	expect(await db.prepare('SELECT * FROM reminder_operations').first()).toBeNull();
	expect(await db.prepare('SELECT * FROM reminder_identities').first()).toBeNull();
	expect((await handleCreateReminder(request(body), env)).status).toBe(410);
	expect((await handleCreateReminder(request({ ...body, operationId: createReminderOperationId(day) }), env)).status).toBe(400);
	expect((await readCommittedMarkdownFileVersion(bucket, db, path))!.content).toBe('# Inbox\n');
});

it('never advances recurring completion again after a lost response, expiry, pruning and restoration of the original revision', async () => {
	const id = createReminderOperationId(day);
	const { reminder } = await payload(await handleCreateReminder(request({ id, operationId: id, content: 'Water plant',
		dueDatetime: '2099-01-01T09:00:00Z', recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0 } }), env));
	const before = (await readCommittedMarkdownFileVersion(bucket, db, path))!;
	const issued = day - REMINDER_RETRY_DAYS + 1;
	const body = { id, operationId: createReminderOperationId(issued), filePath: path, expectedRevision: reminder.revision, completed: true };
	const batch = db.batch.bind(db);
	vi.spyOn(db, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('Lost commit response'); });
	await expect(handleSetReminderCompleted(request(body), env)).rejects.toThrow('Lost commit response');
	const receipt = await payload(await handleSetReminderCompleted(request(body), env));
	expect(receipt.reminder.dueDatetime).toBe('2099-01-02T09:00:00.000Z');
	await setFloor(issued + 1);
	await pruneReminderOperations(db);
	const advanced = (await readCommittedMarkdownFileVersion(bucket, db, path))!;
	await writeCommittedMarkdownFile(bucket, db, path, before.content, advanced.hash);
	expect((await handleSetReminderCompleted(request(body), env)).status).toBe(410);
	expect((await readCommittedMarkdownFileVersion(bucket, db, path))!.content).toBe(before.content);
});

it.each(['completion', 'move'] as const)('rolls back the entire %s publication if expiration advances after validation', async kind => {
	const id = createReminderOperationId(day);
	const { reminder } = await payload(await handleCreateReminder(request({ id, operationId: id, content: 'Keep original' }), env));
	const before = (await readCommittedMarkdownFileVersion(bucket, db, path))!;
	const operationId = createReminderOperationId(day);
	const body = { id, operationId, filePath: path, expectedRevision: reminder.revision,
		...(kind === 'move' ? { project: 'Work', content: 'Moved' } : { completed: true }) };
	const batch = db.batch.bind(db);
	vi.spyOn(db, 'batch').mockImplementationOnce(async statements => { await setFloor(day + 1); return batch(statements); });
	const mutate = kind === 'move' ? handleUpdateReminder : handleSetReminderCompleted;
	await expect(mutate(request(body), env)).rejects.toThrow('NOT NULL');
	expect(await readCommittedMarkdownFileVersion(bucket, db, path)).toEqual(before);
	expect(await readCommittedMarkdownFileVersion(bucket, db, 'Reminders/Work.md')).toBeNull();
	expect(await db.prepare('SELECT * FROM reminder_operations WHERE operation_id = ?').bind(operationId).first()).toBeNull();
	expect((await mutate(request(body), env)).status).toBe(410);
});

it('replays legacy receipts only while retained and preserves finite legacy and active identity reservations', async () => {
	const legacyId = crypto.randomUUID();
	const body = { operationId: legacyId };
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ action: 'create', body })));
	const requestHash = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
	await db.prepare('INSERT INTO reminder_operations VALUES (?, ?, ?, ?)').bind(legacyId, requestHash, '{"success":true}', '2000-01-01 00:00:00').run();
	await db.prepare('INSERT INTO reminder_identities VALUES (?, ?)').bind('legacy-reminder', legacyId).run();
	const active = createReminderOperationId(day - REMINDER_RETRY_DAYS);
	await db.prepare('INSERT INTO reminder_identities VALUES (?, ?)').bind(active, active).run();
	await db.prepare('INSERT INTO reminder_sources VALUES (?, ?, ?, 1)').bind('Reminders/Quarantined.md', active, '').run();
	const retained = await beginReminderOperation(db, body, 'create');
	expect(retained).toBeInstanceOf(Response);
	expect((retained as Response).status).toBe(200);
	await pruneReminderOperations(db);
	expect((await beginReminderOperation(db, body, 'create') as Response).status).toBe(410);
	expect((await db.prepare('SELECT reminder_id FROM reminder_identities').all()).results).toHaveLength(2);
});

it('bounds receipt cleanup, retains a monotonic floor and rolls back a failed pruning batch', async () => {
	const ids = Array.from({ length: 501 }, () => createReminderOperationId(day - REMINDER_RETRY_DAYS));
	await db.prepare("INSERT INTO reminder_operations (operation_id, request_hash, response_json) SELECT value, 'hash', '{}' FROM json_each(?)").bind(JSON.stringify(ids)).run();
	const batch = db.batch.bind(db);
	vi.spyOn(db, 'batch').mockImplementationOnce(statements => batch([...statements, db.prepare("INSERT INTO reminder_operations (operation_id, request_hash, response_json) VALUES ('failure', 'hash', NULL)")]));
	await expect(pruneReminderOperations(db)).rejects.toThrow('NOT NULL');
	expect(await db.prepare('SELECT COUNT(*) AS count FROM reminder_operations').first()).toEqual({ count: 501 });
	expect(await db.prepare("SELECT * FROM maintenance_state WHERE key = 'reminder_operation_floor'").first()).toBeNull();
	await pruneReminderOperations(db);
	expect(await db.prepare('SELECT COUNT(*) AS count FROM reminder_operations').first()).toEqual({ count: 1 });
	await setFloor(day + 10);
	await pruneReminderOperations(db);
	expect(await db.prepare("SELECT value FROM maintenance_state WHERE key = 'reminder_operation_floor'").first()).toEqual({ value: String(day + 10) });
	expect(await db.prepare('SELECT COUNT(*) AS count FROM reminder_operations').first()).toEqual({ count: 0 });
	expect((await beginReminderOperation(db, { operationId: createReminderOperationId(day) }, 'create') as Response).status).toBe(410);
});
