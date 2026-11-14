/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createReminderOperationId, REMINDER_RETRY_DAYS } from '../../../protocol/reminder-operation';
import { reminderRequestHash } from '../reminders/request-hash';
import { prepareEncryptedReceipt, readEncryptedReceipt } from './receipt-storage';
import { pruneOperationReceipts } from '../maintenance/operation-receipts';
import { beginReminderOperation, reminderOperationEffects } from '../reminders/operations';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const envelope = (size = 1_100_000) => `header.key.iv.${'a'.repeat(size)}.tag`;
const chunkCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_chunks').first<{ count: number }>())!.count;

it('replays a large acknowledgment after commit and rejects changed requests before reading chunks', async () => {
	const body = { operationId: operationId(), acknowledgment: envelope() };
	const operation = await beginReminderOperation(env.DB, body, 'encrypted-files');
	if (operation instanceof Response) throw new Error(await operation.text());
	await env.DB.prepare("INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES ('note.md', 'note.md', 'hash', 1, 'revision')").run();
	const response = { encrypted: body.acknowledgment };
	await env.DB.batch(reminderOperationEffects(env.DB, operation, response)([{ path: 'note.md', storageKey: 'revision' }]));
	expect(await chunkCount()).toBeGreaterThan(1);
	const replay = await beginReminderOperation(env.DB, body, 'encrypted-files');
	expect(replay).toBeInstanceOf(Response);
	expect(await (replay as Response).json()).toEqual(response);
	await env.DB.prepare('DELETE FROM operation_chunks WHERE idx = 0').run();
	const mismatch = await beginReminderOperation(env.DB, { ...body, acknowledgment: 'different' }, 'encrypted-files');
	expect((mismatch as Response).status).toBe(409);
	await expect(beginReminderOperation(env.DB, body, 'encrypted-files')).rejects.toThrow('incomplete');
});

it('rolls back chunks when an operation expires, and publishes no chunks for a stale file', async () => {
	const id = operationId(), response = { encrypted: envelope() };
	const requestHash = await reminderRequestHash('encrypted-files', { operationId: id });
	const file = { path: 'note.md', storageKey: 'revision' };
	await env.DB.prepare("INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES ('note.md', 'note.md', 'hash', 1, 'revision')").run();
	await expect(env.DB.batch(reminderOperationEffects(env.DB, { id, requestHash, day: 0 }, response)([file]))).rejects.toThrow();
	expect(await chunkCount()).toBe(0);
	expect(await env.DB.prepare("SELECT 1 FROM operations WHERE kind = 'reminder'").first()).toBeNull();
	await env.DB.batch(reminderOperationEffects(env.DB, { id, requestHash, day: Math.floor(Date.now() / 86400000) }, response)([{ ...file, storageKey: 'stale' }]));
	expect(await chunkCount()).toBe(0);
});

it('keeps small responses inline and prunes large chunks with their expired receipt', async () => {
	expect(prepareEncryptedReceipt(env.DB, 'reminder', operationId(), { encrypted: 'small' }, { sql: '1', args: [] }).statements).toEqual([]);
	const today = Math.floor(Date.now() / 86400000), value = { encrypted: envelope(2_200_000) };
	const store = async (id: string) => {
		const receipt = prepareEncryptedReceipt(env.DB, 'reminder', id, value, { sql: '1', args: [] });
		expect(receipt.statements.length).toBeGreaterThan(4);
		await env.DB.batch([...receipt.statements, env.DB.prepare("INSERT INTO operations(kind, operation_id, request_hash, response_json) VALUES ('reminder', ?, ?, ?)").bind(id, 'hash', receipt.json)]);
		return receipt.json;
	};
	const live = operationId(), expired = createReminderOperationId(today - REMINDER_RETRY_DAYS);
	const json = await store(live);
	await store(expired);
	const perReceipt = (await chunkCount()) / 2;
	await pruneOperationReceipts(env.DB);
	expect(await readEncryptedReceipt(env.DB, 'reminder', live, json)).toEqual(value);
	expect(await chunkCount()).toBe(perReceipt);
	expect(await env.DB.prepare('SELECT 1 FROM operation_chunks WHERE operation_id = ?').bind(expired).first()).toBeNull();
});
