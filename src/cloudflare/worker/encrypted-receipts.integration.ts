/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createVaultKeyBundle, addReminderScope, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { reminderRequestHash } from '../../encryption/reminder-receipt';
import { ENCRYPTION_STATE_KEY } from './encryption-state';
import { handleEncryptionConversion } from './encryption-conversion';
import { handleEncryptionRoute } from './routes/encryption';
import { prepareEncryptedReceipt, readEncryptedReceipt, pruneEncryptedReceiptChunks } from './encrypted-receipt-storage';
import { beginReminderOperation, reminderOperationEffects } from './reminders-web/operations';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const envelope = (size = 1_100_000) => `header.key.iv.${'a'.repeat(size)}.tag`;
const chunkCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS count FROM maintenance_state WHERE key GLOB 'e2ee:receipt:*'").first<{ count: number }>())!.count;

it('converts large legacy responses atomically, preserves first ciphertext on retry, and restricts folder receipts', async () => {
	const bundle = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Private');
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_STATE_KEY, JSON.stringify(state)).run();
	const id = operationId();
	await env.DB.prepare('INSERT INTO reminder_operations(operation_id, request_hash, response_json) VALUES (?, ?, ?)').bind(id, 'old-hash', '{"success":true}').run();
	const body = { operationId: id, vault: envelope(), scopes: [{ id: bundle.scopes[0]!.id, envelope: envelope() }] };
	const convert = (value: typeof body) => handleEncryptionConversion(new Request('https://test/encryption/conversion/receipt', { method: 'PUT', body: JSON.stringify(value),
		headers: { 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) } }), env, '/encryption/conversion/receipt');
	expect((await convert(body))?.status).toBe(200);
	const count = await chunkCount(); expect(count).toBeGreaterThan(4);
	expect((await convert({ ...body, vault: 'other.key.iv.cipher.tag', scopes: [] }))?.status).toBe(200);
	expect(await chunkCount()).toBe(count);
	const saved = (await env.DB.prepare('SELECT response_json FROM reminder_operations WHERE operation_id = ?').bind(id).first<{ response_json: string }>())!.response_json;
	expect(await readEncryptedReceipt(env.DB, 'reminder', id, saved)).toEqual({ e2eeLegacy: { vault: body.vault, scopes: body.scopes } });
	for (const folder of ['Reminders', 'Private']) {
		const response = await handleEncryptionRoute(new Request(`https://test/reminders/encrypted-receipt?operationId=${id}&folderPath=${folder}`), env.DB,
			'/reminders/encrypted-receipt', { scope: 'reminders', tokenId: folder, folderPath: folder });
		expect(await response!.json()).toEqual({ envelope: folder === 'Reminders' ? body.scopes[0]!.envelope : null });
	}
	await pruneEncryptedReceiptChunks(env.DB);
	expect(await chunkCount()).toBe(count);
	await env.DB.prepare('DELETE FROM reminder_operations WHERE operation_id = ?').bind(id).run();
	await pruneEncryptedReceiptChunks(env.DB);
	expect(await chunkCount()).toBe(0);
});

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

it('keeps small responses inline and retains upload chunks until their parent is removed', async () => {
	expect(prepareEncryptedReceipt(env.DB, 'reminder', operationId(), { encrypted: 'small' }, { sql: '1', args: [] }).statements).toEqual([]);
	const id = operationId(), value = { e2eeLegacy: { vault: envelope(), scopes: [] } };
	const receipt = prepareEncryptedReceipt(env.DB, 'upload', id, value, { sql: '1', args: [] });
	await env.DB.batch([...receipt.statements, env.DB.prepare('INSERT INTO upload_operations(operation_id, request_hash, response_json) VALUES (?, ?, ?)').bind(id, 'hash', receipt.json)]);
	await pruneEncryptedReceiptChunks(env.DB);
	expect(await readEncryptedReceipt(env.DB, 'upload', id, receipt.json)).toEqual(value);
	await env.DB.prepare('DELETE FROM upload_operations WHERE operation_id = ?').bind(id).run();
	await pruneEncryptedReceiptChunks(env.DB); expect(await chunkCount()).toBe(0);
});

it('bounds orphan cleanup and resumes its cursor on the next pass', async () => {
	const keys = Array.from({ length: 105 }, (_, index) => `e2ee:receipt:reminder:orphan${String(index).padStart(3, '0')}:000`);
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) SELECT value, 'ciphertext' FROM json_each(?)").bind(JSON.stringify(keys)).run();
	await pruneEncryptedReceiptChunks(env.DB); expect(await chunkCount()).toBe(5);
	await pruneEncryptedReceiptChunks(env.DB); expect(await chunkCount()).toBe(0);
	expect(await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key = 'e2ee:receipt-cleanup-cursor'").first()).toBeNull();
});
