/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { SyncRuntime } from '../../sync/runtime';
import type { SyncEngine } from '../../sync/engine';
import type { SyncHistoryEntry } from '../../sync/types';
import { createSharedCheckpoint, pruneSharedCheckpoints } from './history-checkpoints';
import worker from './index';
import { sha256Hex } from './auth';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => {
    for (const client of clients.splice(0)) { client.close(); await client.engine.waitForIdle(); }
    vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});
async function sync(client: SyncTestDevice) {
    const result = await client.engine.sync();
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.success).toBe(true);
}

it('restores a full checkpoint through real sync and converges another device', async () => {
    const first = new SyncTestDevice('restore-first', env), second = new SyncTestDevice('restore-second', env);
    clients.push(first, second);
    for (const client of clients) { await client.authorize(); await client.open(); }
    first.disk.write('edited.md', 'before edit\n');
    first.disk.write('deleted.md', 'before deletion\n');
    first.disk.write('original.md', 'before rename\n');
    await sync(first);
    const checkpoint = await first.engine.saveHistoryCheckpoint();
    expect(checkpoint).toMatch(/^[a-f0-9]{64}$/);
    await sync(second);
    first.disk.write('edited.md', 'after edit\n');
    first.disk.remove('deleted.md');
    first.disk.rename('original.md', 'renamed.md');
    first.disk.write('added.md', 'after checkpoint\n');
    await sync(first); await sync(second);
    const runtime = historyRuntime(first, checkpoint!);
    const review = await runtime.createHistoryRestore(first.settings.syncHistory[0]!);
    expect(review.items).toHaveLength(5);
    await review.restore();
    await sync(second);
    for (const client of clients) {
        expect(client.disk.paths()).toEqual(['deleted.md', 'edited.md', 'original.md']);
        expect(client.disk.text('edited.md')).toBe('before edit\n');
        expect(client.disk.text('deleted.md')).toBe('before deletion\n');
        expect(client.disk.text('original.md')).toBe('before rename\n');
    }
    expect(Object.keys((await first.api.getManifest()).files).sort()).toEqual(['deleted.md', 'edited.md', 'original.md']);
});

function historyRuntime(device: SyncTestDevice, checkpoint: string): SyncRuntime {
    const entry: SyncHistoryEntry = { timestamp: new Date().toISOString(), type: 'sync', success: true,
        uploaded: 1, downloaded: 0, merged: 0, deleted: 0, conflictCount: 0, errorCount: 0, historyCheckpoint: checkpoint };
    device.settings.syncHistory.push(entry);
    const runtime = new SyncRuntime({} as never, device.settings, {} as never, async update => { Object.assign(device.settings, update); });
    (runtime as unknown as { syncEngine: SyncEngine }).syncEngine = device.engine;
    return runtime;
}

it('restores a historical file after that path became a directory', async () => {
    const device = new SyncTestDevice('restore-namespace', env);
    clients.push(device); await device.authorize(); await device.open();
    device.disk.write('note.md', 'original file');
    await sync(device);
    const checkpoint = await device.engine.saveHistoryCheckpoint();
    device.disk.remove('note.md');
    await sync(device);
    await device.disk.vault.createFolder('note.md');
    device.disk.write('note.md/child.md', 'later file in directory');
    await sync(device);
    const runtime = historyRuntime(device, checkpoint!);
    await (await runtime.createHistoryRestore(device.settings.syncHistory[0]!)).restore();
    expect(device.disk.paths()).toEqual(['note.md']);
    expect(device.disk.text('note.md')).toBe('original file');
    expect(Object.keys((await device.api.getManifest()).files)).toEqual(['note.md']);
});

it('discovers a checkpoint on another Mac and rolls back without the originating device metadata', async () => {
    const first = new SyncTestDevice('shared-first', env), second = new SyncTestDevice('shared-second', env);
    clients.push(first, second);
    for (const device of clients) { await device.authorize(); await device.open(); }
    first.disk.write('edited.md', 'original'); first.disk.write('deleted.md', 'bring back');
    await sync(first);
    const checkpoint = await first.api.sharedHistory.save();
    expect(checkpoint).toBeDefined();
    expect(await second.api.sharedHistory.list()).toEqual([checkpoint]);
    expect(second.settings.syncHistory).toEqual([]);
    first.disk.write('edited.md', 'later edit'); first.disk.remove('deleted.md'); first.disk.write('added.md', 'later addition');
    await sync(first); await sync(second);
    const runtime = historyRuntime(second, '');
    const entry = second.settings.syncHistory[0]!;
    delete entry.historyCheckpoint; entry.sharedCheckpoint = checkpoint!.id;
    await (await runtime.createHistoryRestore(entry)).restore();
    await sync(first);
    for (const device of clients) {
        expect(device.disk.paths()).toEqual(['deleted.md', 'edited.md']);
        expect(device.disk.text('edited.md')).toBe('original');
        expect(device.disk.text('deleted.md')).toBe('bring back');
    }
});

it('downloads retained checkpoint attachments larger than the file-preview limit', async () => {
    const device = new SyncTestDevice('shared-binary', env); clients.push(device);
    await device.authorize(); await device.open();
    const original = new Uint8Array(300_000).fill(42).buffer;
    device.disk.write('attachment.bin', original); await sync(device);
    const checkpoint = (await device.api.sharedHistory.save())!;
    const document = await device.api.sharedHistory.load(checkpoint.id);
    device.disk.write('attachment.bin', new Uint8Array(300_000).fill(43).buffer); await sync(device);
    expect(await device.api.sharedHistory.download(checkpoint.id, 'attachment.bin', document.files['attachment.bin']!)).toEqual(original);
});

it('deduplicates unchanged states and concurrent checkpoint publication', async () => {
    const device = new SyncTestDevice('shared-race', env); clients.push(device);
    await device.authorize(); await device.open(); device.disk.write('note.md', 'one'); await sync(device);
    const [one, two] = await Promise.all([device.api.sharedHistory.save(), device.api.sharedHistory.save()]);
    expect(one!.id).toBe(two!.id);
    expect((await device.api.sharedHistory.save())!.id).toBe(one!.id);
    expect(await device.api.sharedHistory.list()).toHaveLength(1);
});

it('expires checkpoints on the server and refuses reads by a stale client', async () => {
    const device = new SyncTestDevice('shared-expiry', env); clients.push(device);
    await device.authorize(); await device.open(); device.disk.write('note.md', 'one'); await sync(device);
    const checkpoint = (await device.api.sharedHistory.save())!;
    await env.BUCKET.put('__crate__/history/index.json', JSON.stringify({ version: 1, checkpoints: [{ ...checkpoint,
        timestamp: new Date(Date.now() - 2000).toISOString(), expiresAt: Date.now() - 1000 }] }));
    expect(await device.api.sharedHistory.list()).toEqual([]);
    await expect(device.api.sharedHistory.load(checkpoint.id)).rejects.toThrow('expired');
});

it('caps the shared index at twenty checkpoints', async () => {
    const device = new SyncTestDevice('shared-limit', env); clients.push(device);
    await device.authorize(); await device.open();
    const ids: string[] = [];
    for (let index = 0; index < 22; index++) {
        await env.DB.prepare("INSERT INTO changelog(path, action, hash, size) VALUES ('test.md', 'delete', '', 0)").run();
        ids.push((await device.api.sharedHistory.save())!.id);
    }
    const list = await device.api.sharedHistory.list();
    expect(list).toHaveLength(20);
    expect(list.map(entry => entry.id)).toEqual(ids.slice(-20).reverse());
    await expect(device.api.sharedHistory.load(ids[0]!)).rejects.toThrow('replaced');
});

it('rejects a checkpoint if the server changes between inventory pages', async () => {
    const paths = Array.from({ length: 2001 }, (_, i) => `file-${String(i).padStart(5, '0')}.md`);
    await env.DB.prepare(`INSERT INTO files(path, portable_path, hash, size, storage_key)
        SELECT value, value, ?, 1, '__crate__/files/' || value FROM json_each(?)`).bind('a'.repeat(64), JSON.stringify(paths)).run();
    let pages = 0;
    const db = { prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (!sql.includes('WHERE portable_path > ? ORDER BY portable_path LIMIT ?')) return statement;
        return { bind: (...values: unknown[]) => ({ all: async () => {
            const rows = await statement.bind(...values).all();
            if (++pages === 1) await env.DB.prepare("INSERT INTO changelog(path, action, hash, size) VALUES ('another.md', 'delete', '', 0)").run();
            return rows;
        } }) };
    } } as D1Database;
    expect((await createSharedCheckpoint(env.BUCKET, db)).status).toBe(409);
    expect(pages).toBe(2);
    expect(await env.BUCKET.get('__crate__/history/index.json')).toBeNull();
});

it('recovers a lost index-write response without creating a duplicate restore point', async () => {
    let failed = false;
    const bucket = {
        get: env.BUCKET.get.bind(env.BUCKET),
        put: async (key: string, body: string, options?: R2PutOptions) => {
            const result = await env.BUCKET.put(key, body, options);
            if (key.endsWith('/index.json') && !failed) { failed = true; throw new Error('Lost response'); }
            return result;
        },
    } as R2Bucket;
    await expect(createSharedCheckpoint(bucket, env.DB)).rejects.toThrow('Lost response');
    const response = await createSharedCheckpoint(env.BUCKET, env.DB);
    expect(response.status).toBe(200);
    const index = JSON.parse(await (await env.BUCKET.get('__crate__/history/index.json'))!.text()) as { checkpoints: Array<{ id: string }> };
    expect(index.checkpoints).toHaveLength(1);
    expect((await response.json() as { checkpoint: { id: string } }).checkpoint.id).toBe(index.checkpoints[0]!.id);
});

it('collects unreferenced checkpoint metadata without deleting live inventories or vault bytes', async () => {
    const response = await createSharedCheckpoint(env.BUCKET, env.DB);
    const { checkpoint } = await response.json() as { checkpoint: { id: string } };
    await env.BUCKET.put('__crate__/history/checkpoints/orphan.json', '{}');
    await env.BUCKET.put('__crate__/files/keep', 'vault bytes');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86_400_000);
    await pruneSharedCheckpoints(env.BUCKET, env.DB);
    expect(await env.BUCKET.get('__crate__/history/checkpoints/orphan.json')).toBeNull();
    expect(await env.BUCKET.get(`__crate__/history/checkpoints/${checkpoint.id}.json`)).not.toBeNull();
    expect(await (await env.BUCKET.get('__crate__/files/keep'))!.text()).toBe('vault bytes');
});

it('rejects reminder-only tokens and arbitrary object keys', async () => {
    await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path) VALUES ('reminder',?,'reminders','Notes')").bind(await sha256Hex('reminder')).run();
    for (const route of ['/sync/checkpoints', '/sync/checkpoint?id=12345678-1234-1234-1234-123456789012', '/sync/checkpoint-file?id=12345678-1234-1234-1234-123456789012&path=note.md&revision=__crate__/settings.json']) {
        expect((await worker.fetch(new Request(`https://worker.test${route}`, { headers: { Authorization: 'Bearer reminder' } }), env)).status).toBe(403);
    }
    const device = new SyncTestDevice('shared-auth', env); clients.push(device); await device.authorize(); await device.open();
    const checkpoint = (await device.api.sharedHistory.save())!;
    const response = await worker.fetch(new Request(`https://worker.test/sync/checkpoint-file?id=${checkpoint.id}&path=note.md&revision=__crate__/settings.json`, { headers: { Authorization: `Bearer ${device.id}` } }), env);
    expect(response.status).toBe(410);
});

it.each(['update', 'delete'])('retains checkpoint bytes for thirty days from commit even when an earlier %s request supplied an older clock', async action => {
    const device = new SyncTestDevice(`shared-retention-${action}`, env); clients.push(device);
    await device.authorize(); await device.open(); device.disk.write('note.md', 'original'); await sync(device);
    const checkpoint = (await device.api.sharedHistory.save())!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 5 * 60_000);
    if (action === 'update') device.disk.write('note.md', 'new'); else device.disk.remove('note.md');
    await sync(device);
    const retained = await env.DB.prepare("SELECT expires_at FROM file_versions WHERE path='note.md'").first<{ expires_at: number }>();
    expect(retained!.expires_at).toBeGreaterThanOrEqual(checkpoint.expiresAt);
});
