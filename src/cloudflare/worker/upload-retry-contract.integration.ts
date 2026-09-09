/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleUpload, handleDelete } from './sync-file-handlers';
import { handleBatchUpload } from './sync-batch/upload';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { sha256Hex } from './auth';
import { SyncTestDevice } from './sync-engine-test-harness';
import { pruneReminderOperations } from './maintenance/reminder-history';
import type { UploadResult } from '@/protocol/sync-types';

const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { for (const device of devices.splice(0)) device.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });
const day = () => Math.floor(Date.now() / 86400000);
const id = () => createReminderOperationId(day());
async function upload(operationId: string, batch: boolean, content = 'Original bytes', expectedHash: string | null = null): Promise<UploadResult> {
	const hash = await sha256Hex(content);
	const path = 'note.md';
	const response = batch
		? await handleBatchUpload(new Request('https://test/sync/batch-upload', { method: 'POST', body: JSON.stringify({ files: [{ operationId, path, content: btoa(content), hash, size: content.length, contentType: 'text/markdown', expectedHash }] }) }), env.BUCKET, env.DB)
		: await handleUpload(new Request(`https://test/sync/upload?path=${path}`, { method: 'PUT', body: content, headers: { 'X-Crate-Upload-Operation': operationId, 'X-Crate-Expected-Hash': expectedHash ?? 'absent', 'Content-Type': 'text/markdown' } }), env.BUCKET, env.DB);
	const body = await response.json() as UploadResult & { results?: UploadResult[] };
	return body.results?.[0] ?? { ...body, ...(!body.success ? { status: response.status } : {}) };
}
async function remove(receipt: UploadResult) {
	const response = await handleDelete(new Request('https://test/sync/delete', { method: 'POST', body: JSON.stringify({ path: receipt.path, expectedHash: receipt.hash, expectedRevision: receipt.revision }) }), env.BUCKET, env.DB);
	expect(response.status).toBe(200);
}

it.each([false, true])('does not resurrect a deleted file when a committed %s upload is retried', async batch => {
	const operation = id();
	const committed = await upload(operation, batch);
	expect(committed.success).toBe(true);
	await remove(committed);
	expect(await upload(operation, batch)).toEqual(committed);
	expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
	expect((await env.DB.prepare('SELECT * FROM changelog').all()).results).toHaveLength(2);
	const recreated = await upload(id(), batch);
	expect(recreated.success).toBe(true);
	expect(recreated.revision).not.toBe(committed.revision);
});

it.each([false, true])('binds %s upload receipts to bytes and persists rejected preconditions', async batch => {
	const committed = await upload(id(), batch);
	const rejectedId = id();
	const rejected = await upload(rejectedId, batch, 'Other bytes');
	expect(rejected).toMatchObject({ success: false, code: 'version_conflict' });
	await remove(committed);
	expect(await upload(rejectedId, batch, 'Other bytes')).toEqual(rejected);
	expect(await upload(rejectedId, batch, 'Different bytes')).toMatchObject({ success: false, code: 'operation_mismatch' });
	expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
});

it('serializes concurrent retries to one logical commit', async () => {
	const operation = id();
	const results = await Promise.all([upload(operation, false), upload(operation, true)]);
	expect(results[0]).toEqual(results[1]);
	expect(results[0].success).toBe(true);
	expect((await env.DB.prepare('SELECT * FROM changelog').all()).results).toHaveLength(1);
});

it('rejects expired operations after pruning their receipts', async () => {
	const operation = id();
	await upload(operation, false);
	await env.DB.prepare("INSERT INTO maintenance_state(key,value) VALUES('reminder_operation_floor', ?)").bind(String(day() + 1)).run();
	await pruneReminderOperations(env.DB);
	expect(await upload(operation, false)).toMatchObject({ success: false, code: 'operation_expired', status: 410 });
});

it('recovers a lost upload response after restart before interpreting a later remote deletion', async () => {
	const first = new SyncTestDevice('retry-first', env); devices.push(first);
	await first.authorize(); await first.open();
	first.disk.write('note.md', 'Original bytes');
	const paused = first.pauseNextUploadResponse();
	const syncing = first.engine.sync();
	await paused.committed;
	const row = await env.DB.prepare('SELECT hash, storage_key FROM files WHERE path = ?').bind('note.md').first<{ hash: string; storage_key: string }>();
	expect(row).not.toBeNull();
	await remove({ success: true, path: 'note.md', hash: row!.hash, revision: row!.storage_key });
	first.close(); paused.release(); await syncing; await first.engine.waitForIdle();
	await first.open();
	const result = await first.engine.sync();
	expect(result.errors).toEqual([]);
	expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
	expect(first.disk.paths()).not.toContain('note.md');
	expect((await env.DB.prepare('SELECT * FROM changelog').all()).results).toHaveLength(2);
});

it('does not replay an older acknowledged journal entry when cleanup failed after a newer checkpoint', async () => {
	const client = new SyncTestDevice('journal-cleanup', env); devices.push(client);
	await client.authorize(); await client.open();
	client.disk.write('note.md', 'First version');
	const adapter = client.disk.vault.adapter;
	const removeFile = adapter.remove.bind(adapter);
	let firstJournal: string | undefined;
	vi.spyOn(adapter, 'remove').mockImplementation(async path => {
		if (path.includes('/pending-uploads/')) {
			firstJournal ??= path;
			if (path === firstJournal) throw new Error('Cleanup unavailable');
		}
		await removeFile(path);
	});
	expect((await client.engine.sync()).errors).toEqual([]);
	client.disk.write('note.md', 'Second version');
	expect((await client.engine.sync()).errors).toEqual([]);
	const file = client.checkpoint().files['note.md']!;
	client.close(); await client.engine.waitForIdle();
	await remove({ success: true, path: 'note.md', hash: file.hash, revision: file.revision });
	await client.open();
	expect((await client.engine.sync()).errors).toEqual([]);
	expect(client.disk.paths()).not.toContain('note.md');
	expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
});

it('does not dispatch uploads when their journal cannot be saved', async () => {
	const client = new SyncTestDevice('journal-write-failed', env); devices.push(client);
	await client.authorize(); await client.open();
	client.disk.write('note.md', 'Only local copy');
	const write = client.disk.vault.adapter.write.bind(client.disk.vault.adapter);
	vi.spyOn(client.disk.vault.adapter, 'write').mockImplementation(async (path, body) => {
		if (path.includes('/pending-uploads/')) throw new Error('Disk full');
		await write(path, body);
	});
	const content = new TextEncoder().encode('Only local copy').buffer;
	await expect(client.api.uploadFile('note.md', content, await sha256Hex('Only local copy'), content.byteLength, 'text/markdown', null)).rejects.toThrow('Disk full');
	expect(client.requests).not.toContain('POST /sync/batch-upload');
	expect(client.requests).not.toContain('PUT /sync/upload');
	expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
	expect(client.disk.text('note.md')).toBe('Only local copy');
});
