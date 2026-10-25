/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createReminderOperationId } from '../../../protocol/reminder-operation';
import { reminderRequestHash } from '../../../encryption/reminder-receipt';
import { prepareEncryptedReceipt, readEncryptedReceipt, pruneEncryptedReceiptChunks, RECEIPT_CHUNK_PAGE } from './receipt-storage';
import { beginReminderOperation, reminderOperationEffects } from '../reminders/operations';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const envelope = (size = 1_100_000) => `header.key.iv.${'a'.repeat(size)}.tag`;
const chunkCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS count FROM maintenance_state WHERE key GLOB 'e2ee:receipt:*'").first<{ count: number }>())!.count;

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
	await env.DB.prepare("DELETE FROM maintenance_state WHERE key GLOB 'e2ee:receipt:*:000'").run();
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
	expect(await env.DB.prepare('SELECT 1 FROM reminder_operations').first()).toBeNull();
	await env.DB.batch(reminderOperationEffects(env.DB, { id, requestHash, day: Math.floor(Date.now() / 86400000) }, response)([{ ...file, storageKey: 'stale' }]));
	expect(await chunkCount()).toBe(0);
});

it('keeps small responses inline and retains large chunks until their parent is removed', async () => {
	expect(prepareEncryptedReceipt(env.DB, 'reminder', operationId(), { encrypted: 'small' }, { sql: '1', args: [] }).statements).toEqual([]);
	const id = operationId(), value = { encrypted: envelope(2_200_000) };
	const receipt = prepareEncryptedReceipt(env.DB, 'reminder', id, value, { sql: '1', args: [] });
	expect(receipt.statements.length).toBeGreaterThan(4);
	await env.DB.batch([...receipt.statements, env.DB.prepare('INSERT INTO reminder_operations(operation_id, request_hash, response_json) VALUES (?, ?, ?)').bind(id, 'hash', receipt.json)]);
	await pruneEncryptedReceiptChunks(env.DB);
	expect(await readEncryptedReceipt(env.DB, 'reminder', id, receipt.json)).toEqual(value);
	await env.DB.prepare('DELETE FROM reminder_operations WHERE operation_id = ?').bind(id).run();
	await pruneEncryptedReceiptChunks(env.DB); expect(await chunkCount()).toBe(0);
});

it('bounds orphan cleanup and resumes its cursor on the next pass', async () => {
	const keys = Array.from({ length: RECEIPT_CHUNK_PAGE + 5 }, (_, index) => `e2ee:receipt:reminder:orphan${String(index).padStart(5, '0')}:000`);
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) SELECT value, 'ciphertext' FROM json_each(?)").bind(JSON.stringify(keys)).run();
	await pruneEncryptedReceiptChunks(env.DB); expect(await chunkCount()).toBe(5);
	await pruneEncryptedReceiptChunks(env.DB); expect(await chunkCount()).toBe(0);
	expect(await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key = 'e2ee:receipt-cleanup-cursor'").first()).toBeNull();
});
