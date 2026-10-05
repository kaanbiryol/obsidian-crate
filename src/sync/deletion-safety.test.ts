import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { PersistentTestVault } from '../test/factories/sync-vault';
import type { ApiHttpTransport } from './worker-api/http';
import { CRATE_PLUGIN_PROTOCOL } from '../protocol';
import { createIncrementalHarness } from './planner-test-harness';
import { runIncrementalSync } from './planner-incremental';
import { assertLocalFileAbsent } from './local-absence';

const path = '.private/note.md';
const entry = { hash: 'a'.repeat(64), revision: 'original-incarnation', size: 4, modified: new Date(1000).toISOString() };

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

async function persistentHarness(lastSeq = 0) {
	const transport = vi.fn<ApiHttpTransport>(async request => {
		const url = new URL(request.url);
		let value: unknown;
		if (url.pathname === '/.well-known/crate') value = { service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) };
		else if (url.pathname === '/sync/manifest') value = { version: 1, files: { [path]: entry }, lastSeq: 100, snapshotSeq: 100, hasMore: false };
		else if (url.pathname === '/sync/changes') value = { cursorExpired: url.searchParams.get('since') === '5', changes: [], lastSeq: 100, hasMore: false };
		else throw new Error(`Unexpected request: ${request.url}`);
		const text = JSON.stringify(value);
		return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
	});
	const h = await createPersistentEngineHarness(transport, { lastSeq, automaticSync: false });
	h.localManifest.setEntry(path, entry); await h.localManifest.save();
	await h.vault.adapter.mkdir('.private');
	return { ...h, transport, restart: async () => {
		h.engine.destroy(); await h.engine.waitForIdle();
		return createPersistentEngineHarness(transport, h.settings, h.disk);
	} };
}

describe('destructive sync requires complete discovery', () => {
	for (const mode of ['full', 'expired-cursor', 'force'] as const) {
		it.each(['root-list', 'hidden-list', 'nested-list', 'stat'])(`${mode} preserves remote files and checkpoint after %s failure`, async failure => {
			const harness = await persistentHarness(mode === 'expired-cursor' ? 5 : 0);
			harness.disk.write(path, 'note');
			if (failure === 'nested-list') await harness.vault.adapter.mkdir('notes/nested');
			const list = harness.vault.adapter.list.bind(harness.vault.adapter);
			vi.spyOn(harness.vault.adapter, 'list').mockImplementation(async folder => {
				if (failure === 'root-list' && !folder || failure === 'hidden-list' && folder === '.private'
					|| failure === 'nested-list' && folder === 'notes/nested') throw new Error('temporary folder failure');
				return list(folder);
			});
			if (failure === 'stat') vi.spyOn(harness.vault.adapter, 'stat').mockRejectedValue(new Error('temporary stat failure'));

			const result = mode === 'force' ? await harness.engine.forceFullSync() : await harness.engine.sync();

			expect(result.success).toBe(false);
			expect(result.errors.join(' ')).toContain('Vault scan incomplete');
			expect(harness.transport.mock.calls.some(([request]) => request.url.includes('delete'))).toBe(false);
			expect(harness.localManifest.getEntry(path)).toEqual(entry);
			expect(harness.settings.lastSeq).toBe(mode === 'expired-cursor' ? 5 : 0);
			expect(harness.engine.getState().status).toBe('error');
			expect((await harness.restart()).localManifest.getEntry(path)).toEqual(entry);
			expect(harness.disk.text(path)).toBe('note');
		});
	}

	it.each(['full', 'force'] as const)('%s rechecks a file recreated after discovery before remote deletion', async mode => {
		const harness = await persistentHarness();
		const exists = harness.vault.adapter.exists.bind(harness.vault.adapter);
		vi.spyOn(harness.vault.adapter, 'exists').mockImplementation(async candidate => {
			if (candidate === path) harness.disk.write(path, 'recreated');
			return exists(candidate);
		});

		const result = mode === 'force' ? await harness.engine.forceFullSync() : await harness.engine.sync();

		expect(result.success).toBe(false);
		expect(result.errors.join(' ')).toContain('Local file exists again');
		expect(harness.transport.mock.calls.some(([request]) => request.url.includes('delete'))).toBe(false);
		expect(harness.disk.text(path)).toBe('recreated');
		expect((await harness.restart()).localManifest.getEntry(path)).toEqual(entry);
		expect(harness.localManifest.getEntry(path)).toEqual(entry);
	});

	it('incremental deletion reclassifies a recreated file without deleting or advancing its cursor', async () => {
		const harness = createIncrementalHarness({ localDeletes: [path] });
		harness.localManifest.getEntry.mockReturnValue(entry);
		harness.vault.adapter.exists.mockResolvedValue(true);
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 9, mtime: 2000 });
		// Reconciliation cannot settle this injected interleaving yet.
		harness.context.reconcileVersionConflicts = async (_paths, result) => { result.errors.push('Retry after local recreation'); };

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 2 });

		expect(result?.success).toBe(false);
		expect(harness.api.batchDelete).not.toHaveBeenCalled();
		expect(harness.localManifest.removeEntry).not.toHaveBeenCalled();
		expect(harness.settings.lastSeq).toBe(10);
	});

	it('does not reinterpret an adapter existence error as absence', async () => {
		const harness = new PersistentTestVault();
		vi.spyOn(harness.vault.adapter, 'exists').mockRejectedValue(new Error('permission denied'));
		await expect(assertLocalFileAbsent(harness.vault as never, path)).rejects.toThrow('permission denied');
	});

	it('allows replacing a removed local file with a directory', async () => {
		const harness = new PersistentTestVault();
		await harness.vault.adapter.mkdir(path);
		await expect(assertLocalFileAbsent(harness.vault as never, path)).resolves.toBeUndefined();
	});
});
