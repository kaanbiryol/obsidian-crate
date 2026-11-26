/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../../test-support/schema-test-harness';
import { cleanUploadLeases } from '../../maintenance/upload-lease-cleanup';
import { finishUploadLeases, trackUploadLease } from './upload-leases';
import { commitStagedFile } from '../mutations';
import { commitNewFiles } from './bulk-new-file-commit';
import { handleBatchUpload } from '../batch/upload';
import { writeCommittedMarkdownFile } from '../markdown-files';
import { getStoredFileRow } from '../storage';
import { createManagedObjectKey } from '../../../../protocol/storage-keys';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { sha256Hex } from '../../../../platform/sha256';
import { runMaintenanceEpisode } from '../../maintenance/lifecycle';
import { handleDiagnostics } from '../../maintenance/diagnostics';

beforeEach(async () => {
	await applySchema(env.DB);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

const expire = () => env.DB.prepare('UPDATE upload_leases SET expires_at = 0 WHERE expires_at IS NOT NULL').run();
const lease = async (keys: string[], put = true) => {
	const { id } = await trackUploadLease(env.DB, keys.map(key => ({ storageKey: key, path: `${key}.md` })));
	if (put) await Promise.all(keys.map(key => env.BUCKET.put(key, 'content')));
	return id;
};
async function expiredObject(content = 'data') {
	const hash = await sha256Hex(content);
	const key = createManagedObjectKey(hash);
	const { id } = await trackUploadLease(env.DB, [{ storageKey: key, path: 'Late.bin' }]);
	await env.BUCKET.put(key, content);
	await expire();
	return { key, hash, id };
}
const request = () => new Request('https://test/sync/batch-upload', { method: 'POST', body: JSON.stringify({
	bulkNewFiles: true, files: Array.from({ length: 8 }, (_, i) => ({ path: `${i}.md`, content: btoa('note'), expectedHash: null,
		operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) })),
}) });

it('removes the lease in the successful file transaction', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Hello', null);
	expect(await env.DB.prepare('SELECT * FROM upload_leases').first()).toBeNull();
});

it('registers one lease before any R2 puts and retires it with the successful commit', async () => {
	const put = env.BUCKET.put.bind(env.BUCKET);
	const counts: number[] = [];
	vi.spyOn(env.BUCKET, 'put').mockImplementation(async (...args) => {
		counts.push((await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_leases').first<{ n: number }>())!.n);
		return put(...args);
	});
	expect((await handleBatchUpload(request(), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles })).status).toBe(200);
	expect(counts).toEqual(Array(8).fill(1));
	expect(await env.DB.prepare('SELECT id FROM upload_leases').first()).toBeNull();
});

it('keeps a lease that still guards an object when a settled key is settled again', async () => {
	const id = await lease(['a', 'b', 'c'], false);
	const settle = (keys: string[]) => env.DB.batch(finishUploadLeases(env.DB, keys.map(key => ({ path: `${key}.md`, objectKey: key, leaseId: id }))));
	await settle(['a', 'b']);
	// A per-file retry after a lost batch response settles a again while c's put may still land.
	await settle(['a']);
	const row = await env.DB.prepare('SELECT keys FROM upload_leases WHERE id = ?').bind(id).first<{ keys: string }>();
	expect(JSON.parse(row!.keys)).toEqual([expect.objectContaining({ storageKey: 'c' })]);
	await settle(['c']);
	expect(await env.DB.prepare('SELECT id FROM upload_leases WHERE id = ?').bind(id).first()).toBeNull();
});

it('does not upload any objects when lease registration fails', async () => {
	const prepare = env.DB.prepare.bind(env.DB);
	vi.spyOn(env.DB, 'prepare').mockImplementation(sql => {
		if (sql.startsWith('INSERT INTO upload_leases')) throw new Error('Database unavailable');
		return prepare(sql);
	});
	const put = vi.spyOn(env.BUCKET, 'put');
	expect((await handleBatchUpload(request(), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles })).status).toBe(503);
	expect(put).not.toHaveBeenCalled();
});

it('cleans an expired object and prevents its late publication', async () => {
	const { key, hash, id } = await expiredObject();
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(1);
	expect(await env.BUCKET.head(key)).toBeNull();
	const result = await commitStagedFile(env.BUCKET, env.DB, {
		path: 'Late.bin', hash, size: 4, objectKey: key, leaseId: id, content: 'data', expectedHash: null,
	});
	expect(result.committed).toBe(false);
	expect(await getStoredFileRow(env.DB, 'Late.bin')).toBeNull();
});

it('cleans expired keys and prevents a delayed bulk commit from publishing them', async () => {
	const response = await handleBatchUpload(request(), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles: async (bucket, db, files) => {
		await expire();
		expect((await cleanUploadLeases(bucket, db)).finished).toBe(8);
		return commitNewFiles(bucket, db, files);
	} });
	const result = await response.json() as { results: Array<{ success: boolean }> };
	expect(result.results).toHaveLength(8);
	expect(result.results.every(file => !file.success)).toBe(true);
	expect(await env.DB.prepare('SELECT path FROM files').first()).toBeNull();
});

it('keeps objects referenced by a live file or retained version', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Old', null);
	const previous = await getStoredFileRow(env.DB, 'Note.md');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'New', previous!.hash);
	const current = await getStoredFileRow(env.DB, 'Note.md');
	await trackUploadLease(env.DB, [previous!, current!].map(file => ({ storageKey: file.storageKey, path: 'Note.md' })));
	await expire();
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(2);
	expect(await env.BUCKET.head(previous!.storageKey)).not.toBeNull();
	expect(await env.BUCKET.head(current!.storageKey)).not.toBeNull();
	expect(await env.DB.prepare('SELECT id FROM upload_leases').first()).toBeNull();
});

it('retains missing keys to collect a late R2 upload without risking committed files', async () => {
	await handleBatchUpload(request(), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles });
	const live = await env.DB.prepare('SELECT storage_key, path FROM files LIMIT 1').first<{ storage_key: string; path: string }>();
	const { id } = await trackUploadLease(env.DB, [{ storageKey: live!.storage_key, path: live!.path }, { storageKey: 'late-key', path: 'late.md' }]);
	await expire();
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(1);
	expect(await env.DB.prepare('SELECT keys, state, attempts FROM upload_leases WHERE id = ?').bind(id).first())
		.toEqual({ keys: '[{"storageKey":"late-key","path":"late.md"}]', state: 'deleting', attempts: 1 });
	expect(await env.BUCKET.head(live!.storage_key)).not.toBeNull();
	await env.BUCKET.put('late-key', 'late bytes');
	await expire();
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(1);
	expect(await env.BUCKET.head('late-key')).toBeNull();
	expect(await env.DB.prepare('SELECT id FROM upload_leases').first()).toBeNull();
});

it('settles a claimed lease that a late commit trimmed during the pass', async () => {
	const [deleted, missing, settled] = ['lease/deleted', 'lease/missing', 'lease/settled'];
	const id = await lease([deleted, settled]);
	await env.DB.prepare('UPDATE upload_leases SET keys = json_insert(keys, \'$[#]\', json(?)) WHERE id = ?')
		.bind(JSON.stringify({ storageKey: missing, path: `${missing}.md` }), id).run();
	await expire();
	// A commit more than a day late settles one key while the pass is deleting objects.
	const remove = env.BUCKET.delete.bind(env.BUCKET);
	vi.spyOn(env.BUCKET, 'delete').mockImplementation(async keys => {
		await env.DB.prepare(`UPDATE upload_leases SET keys = (SELECT json_group_array(json(value)) FROM json_each(keys)
      WHERE json_extract(value, '$.storageKey') != ?) WHERE id = ?`).bind(settled, id).run();
		return remove(keys);
	});
	await cleanUploadLeases(env.BUCKET, env.DB);
	const row = await env.DB.prepare('SELECT keys, attempts FROM upload_leases WHERE id = ?').bind(id).first<{ keys: string; attempts: number }>();
	expect(JSON.parse(row!.keys)).toEqual([{ storageKey: missing, path: `${missing}.md` }]);
	expect(row!.attempts).toBe(1);
	expect(await env.BUCKET.head(deleted)).toBeNull();
});

it('retries a failed R2 delete', async () => {
	for (let i = 0; i < 3; i++) await lease([`key-${i}`]);
	await expire();
	vi.spyOn(env.BUCKET, 'delete').mockRejectedValueOnce(new Error('Unavailable'));
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(0);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_leases WHERE attempts = 1').first()).toEqual({ n: 3 });
	await expire();
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(3);
	expect(await env.DB.prepare('SELECT id FROM upload_leases').first()).toBeNull();
});

it('bounds one pass to ten leases or the objects its subrequests allow', async () => {
	for (let i = 0; i < 12; i++) await lease([`single-${i}`]);
	await expire();
	expect(await cleanUploadLeases(env.BUCKET, env.DB)).toEqual({ finished: 10, more: false });
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_leases').first()).toEqual({ n: 2 });
	await env.DB.prepare('DELETE FROM upload_leases').run();
	for (let i = 0; i < 3; i++) await lease(Array.from({ length: 32 }, (_, index) => `batch-${i}-${index}`));
	await expire();
	const head = vi.spyOn(env.BUCKET, 'head');
	// The first lease is always claimed; the objects past one pass's heads wait for the next.
	expect(await cleanUploadLeases(env.BUCKET, env.DB)).toEqual({ finished: 18, more: true });
	expect(head).toHaveBeenCalledTimes(18);
	expect(await cleanUploadLeases(env.BUCKET, env.DB)).toEqual({ finished: 14, more: false });
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_leases').first()).toEqual({ n: 2 });
});

it('retries absent objects of a lease checked over several passes', async () => {
	const keys = Array.from({ length: 32 }, (_, index) => `batch-${index}`);
	const id = await lease(keys, false);
	// Only the second half was put; the first half may still be uploading.
	await Promise.all(keys.slice(16).map(key => env.BUCKET.put(key, 'content')));
	await expire();
	expect(await cleanUploadLeases(env.BUCKET, env.DB)).toEqual({ finished: 2, more: true });
	const rows = async () => (await env.DB.prepare('SELECT id, keys, state, attempts, expires_at FROM upload_leases ORDER BY expires_at')
		.all<{ id: string; keys: string; state: string; attempts: number; expires_at: number }>()).results
		.map(row => ({ ...row, keys: (JSON.parse(row.keys) as Array<{ storageKey: string }>).map(object => object.storageKey) }));
	// The unchecked objects stay claimed and expired; the absent ones retry under their own lease.
	const [deferred, retrying] = await rows();
	expect(deferred).toMatchObject({ id, keys: keys.slice(18), state: 'deleting', attempts: 0, expires_at: 0 });
	expect(retrying).toMatchObject({ keys: keys.slice(0, 16), state: 'deleting', attempts: 1 });
	expect(retrying!.expires_at).toBeGreaterThan(Date.now());
	expect(await cleanUploadLeases(env.BUCKET, env.DB)).toEqual({ finished: 14, more: false });
	expect((await rows()).map(row => row.keys)).toEqual([keys.slice(0, 16)]);
	expect((await Promise.all(keys.slice(16).map(key => env.BUCKET.head(key)))).filter(Boolean)).toEqual([]);
});

it('pauses missing keys after eight attempts and includes them in diagnostics', async () => {
	await lease(['missing-key'], false);
	for (let i = 0; i < 8; i++) { await expire(); await cleanUploadLeases(env.BUCKET, env.DB); }
	expect(await env.DB.prepare('SELECT attempts, expires_at FROM upload_leases').first()).toEqual({ attempts: 8, expires_at: null });
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(0);
	const diagnostics = await (await handleDiagnostics(env.DB)).json() as { pausedUploadCleanup: Array<{ storageKey: string }> };
	expect(diagnostics.pausedUploadCleanup[0]?.storageKey).toBe('missing-key');
});

it('does not reclaim a successful commit whose response was lost', async () => {
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
		await batch(statements); throw new Error('Response lost');
	});
	await expect(writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Hello', null)).rejects.toThrow('Response lost');
	const current = await getStoredFileRow(env.DB, 'Note.md');
	expect(current).not.toBeNull();
	expect((await cleanUploadLeases(env.BUCKET, env.DB)).finished).toBe(0);
	expect(await env.BUCKET.head(current!.storageKey)).not.toBeNull();
});

it('schedules maintenance at the next lease expiration', async () => {
	const id = await lease(['waiting']);
	const row = await env.DB.prepare('SELECT expires_at FROM upload_leases WHERE id = ?').bind(id).first<{ expires_at: number }>();
	const setAlarm = vi.fn();
	await runMaintenanceEpisode({ storage: { get: async () => 0, put: async () => {}, setAlarm } } as never, env);
	expect(setAlarm).toHaveBeenCalledWith(row!.expires_at);
});
