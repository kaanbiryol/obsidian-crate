import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RequestUrlParam } from 'obsidian';
const requestUrl = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async original => ({ ...await original<object>(), requestUrl }));
import { SyncRuntime } from './runtime';
import { createDeferred } from './runtime-test-harness';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { LocalManifest } from '../manifest/manifest';
import { getCheckpointAuthority } from '../connection/worker-url';
import { DEFAULT_SETTINGS } from '../../plugin/settings-types';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import type { BatchUploadFile } from '../../protocol/sync-types';
import { sha256Hex } from '@/platform/sha256';
import { arrayBufferToBase64 } from '../encoding';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

function reply(value: unknown) {
	const text = JSON.stringify(value);
	return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}

it('walks the vault twice at startup and still syncs an edit made during the startup sync', async () => {
	const disk = new PersistentTestVault();
	const settings = { ...structuredClone(DEFAULT_SETTINGS), workerUrl: 'https://server.test', automaticSync: true, syncInterval: 0,
		debounceDelay: 0.3, lastSeq: 42, lastSync: new Date(1).toISOString() };
	const app = { vault: disk.vault, fileManager: {}, workspace: { layoutReady: true, onLayoutReady: (callback: () => void) => callback() } };
	const baseline = new LocalManifest(app as never, { dir: TEST_PLUGIN_DIR } as never, getCheckpointAuthority(settings));
	await baseline.load();
	for (let index = 0; index < 20; index++) {
		const path = `folder-${index}/note.md`;
		await disk.vault.createFolder(`folder-${index}`);
		disk.write(path, `note ${index}`);
		const stat = (await disk.vault.adapter.stat(path))!;
		baseline.setEntry(path, { hash: await sha256Hex(disk.read(path)), size: stat.size, modified: new Date(stat.mtime).toISOString(), revision: `r${index}` });
	}
	await baseline.save();
	await baseline.close();

	const edited = 'folder-3/note.md', downloaded = 'folder-5/note.md';
	const remote = new TextEncoder().encode('remote edit').buffer;
	const remoteHash = await sha256Hex(remote);
	const downloadRequested = createDeferred<void>();
	const releaseDownload = createDeferred<void>();
	const uploaded: string[] = [];
	requestUrl.mockImplementation(async ({ url, body }: RequestUrlParam) => {
		const route = new URL(url).pathname;
		if (route === '/.well-known/crate') return reply({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) });
		if (route === '/sync/import') return reply({ import: null });
		if (route === '/sync/changes') return reply(new URL(url).searchParams.get('since') === '42'
			? { changes: [{ seq: 43, path: downloaded, action: 'put', hash: remoteHash, size: remote.byteLength, created_at: new Date(2).toISOString(), revision: 'remote' }], lastSeq: 43, hasMore: false }
			: { changes: [], lastSeq: 43, hasMore: false });
		if (route === '/sync/batch-download') {
			// The startup sync scanned local files before downloading.
			downloadRequested.resolve();
			await releaseDownload.promise;
			return reply({ files: [{ path: downloaded, content: arrayBufferToBase64(remote), hash: remoteHash, size: remote.byteLength, contentType: 'text/markdown', revision: 'remote' }] });
		}
		if (route === '/sync/batch-upload') {
			const { files } = JSON.parse(body as string) as { files: BatchUploadFile[] };
			uploaded.push(...files.map(file => file.path));
			return reply({ success: true, results: files.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'edited' })) });
		}
		return { ...reply({ error: 'Not found' }), status: 404 };
	});
	const secrets = new Map([['crate-auth-token', 'token']]);
	const runtime = new SyncRuntime({ app, manifest: { dir: TEST_PLUGIN_DIR }, registerDomEvent: vi.fn() } as never, settings, {
		has: (key: string) => secrets.has(key), get: (key: string) => secrets.get(key) ?? null,
		set: (key: string, value: string) => secrets.set(key, value), delete: (key: string) => secrets.delete(key),
	} as never, async () => {});
	const list = vi.spyOn(disk.vault.adapter, 'list');
	// Obsidian reports the downloaded write as an ordinary modify event.
	const process = disk.vault.process.bind(disk.vault);
	vi.spyOn(disk.vault, 'process').mockImplementation(async (file, update) => {
		const text = await process(file, update);
		runtime.onFileChange(file);
		return text;
	});

	try {
		await runtime.initialize();
		await downloadRequested.promise;
		disk.write(edited, 'edited during the startup sync');
		runtime.onFileChange(disk.vault.getAbstractFileByPath(edited)!);
		releaseDownload.resolve();
		await expect(runtime.waitForStartupSync()).resolves.toBe(true);

		await vi.waitFor(() => expect(runtime.getPendingKeys()).toEqual([]));

		// Before: a third walk probed for edits the startup sync missed, and found this one.
		const walks = (folder: string) => list.mock.calls.filter(([path]) => path === folder).length;
		expect(walks('')).toBe(2);
		expect(walks('folder-7')).toBe(2);
		expect(disk.text(downloaded)).toBe('remote edit');
		expect(uploaded).toEqual([edited]);
	} finally {
		runtime.destroy();
	}
});
