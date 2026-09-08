import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalManifest } from './manifest';
import { deleteManifestFile } from './runtime-config';
import { SyncEngine } from './engine';
import { createDeferred, createRuntimeHarness } from './runtime-test-harness';

const dir = '.obsidian/plugins/crate';
const main = `${dir}/file-manifest.json`;
const entry = { hash: 'original', size: 4, modified: new Date(1000).toISOString(), revision: 'old-revision' };
const checkpoint = (authority?: string, generation = 2) => JSON.stringify({ version: 1, generation, authority, files: { 'note.md': entry } });

function createDisk(initial: Record<string, string> = {}) {
	const disk = new Map(Object.entries(initial));
	const adapter = {
		exists: vi.fn(async (path: string) => disk.has(path)),
		read: vi.fn(async (path: string) => { const value = disk.get(path); if (value === undefined) throw new Error(`Missing ${path}`); return value; }),
		write: vi.fn(async (path: string, data: string) => { disk.set(path, data); }),
		remove: vi.fn(async (path: string) => { disk.delete(path); }),
	};
	const plugin = { app: { vault: { adapter } }, manifest: { dir } };
	const manifest = (authority: string) => new LocalManifest(plugin.app as never, plugin.manifest as never, authority);
	return { disk, adapter, plugin, manifest };
}

afterEach(() => vi.restoreAllMocks());

describe('checkpoint authority and reset', () => {
	it.each(['main', 'temporary'])('refuses another server’s %s checkpoint without modifying either generation', async generation => {
		const source = generation === 'main' ? main : `${main}.tmp`;
		const harness = createDisk({ [source]: checkpoint('https://old.example') });
		await expect(harness.manifest('https://new.example').load()).rejects.toThrow('not bound to this server');
		expect(harness.disk.get(source)).toBe(checkpoint('https://old.example'));
		expect(harness.adapter.write).not.toHaveBeenCalled();
		expect(harness.adapter.remove).not.toHaveBeenCalled();
	});

	it('refuses unscoped pre-release metadata instead of guessing which server owns it', async () => {
		const harness = createDisk({ [main]: checkpoint() });
		await expect(harness.manifest('https://new.example').load()).rejects.toThrow('not bound to this server');
		expect(harness.disk.get(main)).toBe(checkpoint());
	});

	it('recovers only a matching server’s newer temporary generation', async () => {
		const harness = createDisk({ [main]: checkpoint('https://same.example', 1), [`${main}.tmp`]: checkpoint('https://same.example', 2) });
		const loaded = harness.manifest('https://same.example');
		await loaded.load();
		expect(loaded.getEntry('note.md')).toEqual(entry);
		expect(JSON.parse(harness.disk.get(main)!)).toMatchObject({ authority: 'https://same.example', generation: 2 });
	});

	it('archives and invalidates both generations before loading an empty checkpoint for a new server', async () => {
		const harness = createDisk({ [main]: checkpoint('https://old.example', 1), [`${main}.tmp`]: checkpoint('https://old.example', 2) });
		await deleteManifestFile(harness.plugin as never);
		expect(harness.disk.has(main)).toBe(false);
		expect(harness.disk.has(`${main}.tmp`)).toBe(false);
		expect([...harness.disk.values()].sort()).toEqual([checkpoint('https://old.example', 1), checkpoint('https://old.example', 2)].sort());
		const next = harness.manifest('https://new.example');
		await next.load();
		expect(next.getAllPaths()).toEqual([]);
	});

	it.each(['backup', 'remove'])('fails reset on %s failure and preserves recovery bytes', async failure => {
		const harness = createDisk({ [main]: checkpoint('https://old.example'), [`${main}.tmp`]: checkpoint('https://old.example', 3) });
		if (failure === 'backup') harness.adapter.write.mockRejectedValue(new Error('disk full'));
		else harness.adapter.remove.mockRejectedValue(new Error('permission denied'));
		await expect(deleteManifestFile(harness.plugin as never)).rejects.toThrow(failure === 'backup' ? 'disk full' : 'permission denied');
		expect(harness.disk.get(main)).toBe(checkpoint('https://old.example'));
		expect(harness.disk.get(`${main}.tmp`)).toBe(checkpoint('https://old.example', 3));
	});

	it('waits for an old temporary write, then blocks late saves after reset', async () => {
		const harness = createDisk();
		const old = harness.manifest('https://old.example');
		const writing = createDeferred<void>();
		const release = createDeferred<void>();
		harness.adapter.write.mockImplementationOnce(async (path, data) => {
			writing.resolve(); await release.promise; harness.disk.set(path, data);
		});
		old.setEntry('note.md', entry);
		const saving = old.save();
		await writing.promise;
		let closed = false;
		const closing = old.close().then(() => { closed = true; });
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve();
		await Promise.all([saving, closing]);
		await deleteManifestFile(harness.plugin as never);
		old.setEntry('late.md', entry);
		await old.save();
		const next = harness.manifest('https://new.example');
		await next.load();
		expect(next.getAllPaths()).toEqual([]);
		expect(harness.disk.has(main)).toBe(false);
		expect(harness.disk.has(`${main}.tmp`)).toBe(false);
	});

	it('does not adopt new credentials or initialize when checkpoint invalidation fails', async () => {
		const harness = createRuntimeHarness();
		const disk = createDisk({ [main]: checkpoint('https://old.example') });
		Object.assign(harness.plugin.app.vault.adapter, disk.adapter);
		harness.plugin.manifest.dir = dir;
		disk.adapter.remove.mockRejectedValue(new Error('permission denied'));
		const initialize = vi.spyOn(harness.runtime, 'initialize').mockResolvedValue();
		await expect(harness.runtime.applyInfrastructureConfig({ workerUrl: 'https://new.example', authToken: 'new-token' })).rejects.toThrow('permission denied');
		expect(harness.settings.workerUrl).toBe('https://worker.example');
		expect(harness.secretStorage.set).not.toHaveBeenCalled();
		expect(initialize).not.toHaveBeenCalled();
	});

	it('leaves manual sync unavailable after refusing a foreign checkpoint', async () => {
		const harness = createRuntimeHarness({ syncOnStartup: false });
		const disk = createDisk({ [main]: checkpoint('https://old.example') });
		Object.assign(harness.plugin.app.vault.adapter, disk.adapter);
		harness.plugin.manifest.dir = dir;
		await expect(harness.runtime.initialize()).rejects.toThrow('not bound to this server');
		expect(harness.runtime.getApiClient()).toBeNull();
		expect(harness.runtime.getState().status).toBe('error');
		expect((await harness.runtime.sync()).success).toBe(false);
		expect(disk.adapter.write).not.toHaveBeenCalled();
	});

	it('retains the common ancestor and cursor when renewing credentials on the same server', async () => {
		const harness = createRuntimeHarness({ lastSeq: 42, lastSync: '2026-09-01T12:00:00.000Z' });
		const disk = createDisk({ [main]: checkpoint('https://worker.example') });
		Object.assign(harness.plugin.app.vault.adapter, disk.adapter);
		harness.plugin.manifest.dir = dir;
		vi.spyOn(harness.runtime, 'initialize').mockResolvedValue();
		await harness.runtime.applyInfrastructureConfig({ workerUrl: 'https://worker.example/', authToken: 'renewed-token' });
		expect(harness.settings.lastSeq).toBe(42);
		expect(harness.settings.lastSync).toBe('2026-09-01T12:00:00.000Z');
		expect(disk.adapter.remove).not.toHaveBeenCalled();
		expect(disk.disk.get(main)).toBe(checkpoint('https://worker.example'));
	});

	it('does not mutate configuration until the old engine has settled', async () => {
		const harness = createRuntimeHarness();
		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue();
		await harness.runtime.initialize({ skipStartupSync: true });
		const gate = createDeferred<void>();
		const wait = vi.spyOn(SyncEngine.prototype, 'waitForIdle').mockReturnValue(gate.promise);
		const changing = harness.runtime.applyInfrastructureConfig({ workerUrl: 'https://new.example', authToken: 'new-token' });
		await vi.waitFor(() => expect(wait).toHaveBeenCalled());
		expect(harness.settings.workerUrl).toBe('https://worker.example');
		expect(harness.secretStorage.set).not.toHaveBeenCalled();
		gate.resolve();
		await changing;
		expect(harness.settings.workerUrl).toBe('https://new.example');
	});
});
