import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../cloudflare/worker/sync-engine-vault-test-harness';
import { CRATE_PLUGIN_PROTOCOL } from '../protocol';
import { SyncApiClient } from './api';
import { computeHash } from './hasher';
import { LocalManifest } from './manifest';
import { MarkdownBaseCache } from './markdown-base-cache';
import type { ApiHttpTransport } from './worker-api/http';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
	const disk = new PersistentTestVault();
	const app = { vault: disk.vault } as never;
	const plugin = { dir: TEST_PLUGIN_DIR } as never;
	const manifest = new LocalManifest(app, plugin, 'https://server.test');
	const cache = new MarkdownBaseCache(app, plugin);
	const content = new TextEncoder().encode('original').buffer;
	const hash = await computeHash(content);
	const transport = vi.fn<ApiHttpTransport>(async request => {
		if (!request.url.endsWith('/.well-known/crate')) throw new Error('Lost response');
		const text = JSON.stringify({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL,
			reminderOperationDay: Math.floor(Date.now() / 86_400_000), capabilities: [] });
		return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
	});
	const api = new SyncApiClient('https://server.test', 'token', transport);
	const files = api.createFileOperations(manifest, disk.vault, cache);
	return { disk, app, plugin, manifest, content, hash, transport, api, files };
}

it('keeps raw endpoint calls independent of engine journals after binding file operations', async () => {
	const h = await fixture();
	await expect(h.api.uploadFile('raw.md', h.content, h.hash, h.content.byteLength, 'text/markdown', null)).rejects.toThrow('Lost response');
	expect(h.manifest.uploadJournal.pending()).toEqual([]);
	await expect(h.files.uploadFile('owned.md', h.content, h.hash, h.content.byteLength, 'text/markdown', null)).rejects.toThrow('Lost response');
	await h.manifest.close();
	const restarted = new LocalManifest(h.app, h.plugin, 'https://server.test');
	await restarted.load();
	expect(restarted.uploadJournal.pending().map(file => file.path)).toEqual(['owned.md']);
	expect(h.files.getUploadDiagnostics()).not.toHaveLength(0);
	await restarted.close();
});

it('protects remote copies for both single and batch deletion while an upload is unresolved', async () => {
	const h = await fixture();
	await expect(h.files.uploadFile('renamed.md', h.content, h.hash, h.content.byteLength, 'text/markdown', null)).rejects.toThrow('Lost response');
	h.transport.mockClear();
	await expect(h.files.deleteFile('old.md', h.hash, 'r1')).rejects.toThrow('pending uploads');
	await expect(h.files.batchDelete(['old.md'], { 'old.md': h.hash }, { 'old.md': 'r1' })).rejects.toThrow('pending uploads');
	expect(h.transport).not.toHaveBeenCalled();
	await h.manifest.close();
});

it('allows token refresh but refuses to retarget a bound engine to another server', async () => {
	const h = await fixture();
	expect(() => h.api.updateCredentials('https://server.test/', 'new-token')).not.toThrow();
	expect(() => h.api.updateCredentials('https://other.test', 'token')).toThrow('Stop this sync engine');
	expect(h.api.getWorkerUrl()).toBe('https://server.test');
	await h.manifest.close();
});
