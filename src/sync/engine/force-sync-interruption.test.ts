import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { LocalManifest } from '../manifest/manifest';
import { TEST_PLUGIN_DIR } from '../../test/factories/sync-vault';
import { sha256Hex } from '../../platform/sha256';
import type { ApiHttpTransport } from '../worker-api/http';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

it('keeps every checkpoint baseline when a force full sync stops mid-upload', async () => {
	const files = 200;
	let answered = 0;
	const remoteOnly = { hash: 'b'.repeat(64), revision: 'remote-only-rev', size: 1, modified: new Date(5).toISOString() };
	const transport = vi.fn<ApiHttpTransport>(async request => {
		const url = new URL(request.url);
		let value: unknown;
		if (url.pathname === '/.well-known/crate') {
			value = { service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) };
		} else if (url.pathname === '/sync/manifest') {
			value = { version: 1, files: { 'remote-only.md': remoteOnly }, lastSeq: 10, snapshotSeq: 10, hasMore: false };
		} else if (url.pathname === '/sync/changes') {
			value = { changes: [], lastSeq: 10, hasMore: false };
		} else if (url.pathname === '/sync/batch-upload') {
			// Hang after enough receipts for at least one periodic checkpoint.
			if (answered >= 90) return new Promise(() => {});
			const body = JSON.parse(request.body as string) as { files: Array<{ path: string; hash: string }> };
			answered += body.files.length;
			value = { success: true, results: body.files.map(file => ({ path: file.path, success: true, hash: file.hash, revision: `rev-${file.path}` })) };
		} else throw new Error(`Unexpected request: ${request.url}`);
		const text = JSON.stringify(value);
		return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
	});
	const harness = await createPersistentEngineHarness(transport, { lastSeq: 10, automaticSync: false });
	await harness.vault.adapter.mkdir('notes');
	for (let index = 0; index < files; index++) {
		const path = `notes/n-${index}.md`;
		harness.disk.write(path, `note ${index}`);
		const stat = await harness.vault.adapter.stat(path);
		harness.localManifest.setEntry(path, {
			hash: await sha256Hex(new TextEncoder().encode(`note ${index}`).buffer), revision: `old-${index}`,
			size: stat!.size, modified: new Date(stat!.mtime).toISOString(),
		});
	}
	harness.localManifest.setEntry('remote-only.md', remoteOnly);
	await harness.localManifest.save();

	const running = harness.engine.forceFullSync();
	await vi.waitFor(() => expect(answered).toBeGreaterThanOrEqual(90), { timeout: 10_000 });
	harness.engine.destroy();
	expect((await running).outcome).toBe('cancelled');
	await harness.engine.waitForIdle();

	const reopened = new LocalManifest({ vault: harness.disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, 'https://server.test');
	await reopened.load();
	expect(reopened.getFileCount()).toBe(files + 1);
	expect(reopened.getEntry('remote-only.md')).toMatchObject({ revision: 'remote-only-rev' });
	expect(reopened.getEntry('notes/n-0.md')?.revision).toBe('rev-notes/n-0.md');
	expect(reopened.getEntry(`notes/n-${files - 1}.md`)?.revision).toBe(`old-${files - 1}`);
});
