import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { sha256Hex } from '../../platform/sha256';
import { arrayBufferToBase64 } from '../encoding';
import type { ApiHttpResponse, ApiHttpTransport } from '../worker-api/http';
import type { FileEntry } from '../../protocol/sync-types';
import { TEST_PLUGIN_DIR } from '../../test/factories/sync-vault';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

/** A server holding a note and settings, joined by a vault with its own versions of both. */
async function joinedVault(overrides: { replaceVault?: boolean } = {}) {
	const remote = new Map<string, { entry: FileEntry; content: ArrayBuffer }>();
	for (const [path, text] of [['note.md', 'server note'], ['.obsidian/app.json', '{"server":true}']] as const) {
		remote.set(path, { entry: { hash: await sha256Hex(bytes(text)), size: bytes(text).byteLength, modified: '2026-10-01T00:00:00.000Z', revision: `r-${path}` }, content: bytes(text) });
	}
	const writes: string[] = [];
	const transport = vi.fn<ApiHttpTransport>(async (request): Promise<ApiHttpResponse> => {
		const url = new URL(request.url);
		const body = typeof request.body === 'string' ? JSON.parse(request.body) as Record<string, unknown> : {};
		let value: unknown;
		if (url.pathname === '/.well-known/crate') {
			value = { service: 'crate', serverVersion: '0.1.0', serverRevision: 4, protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) };
		} else if (url.pathname === '/sync/changes') {
			value = { changes: [], lastSeq: 5, hasMore: false };
		} else if (url.pathname === '/sync/manifest') {
			value = { version: 1, files: Object.fromEntries([...remote].map(([path, file]) => [path, file.entry])), lastSeq: 5, snapshotSeq: 5, hasMore: false };
		} else if (url.pathname === '/sync/batch-download') {
			const paths = body.paths as string[];
			value = { files: paths.map(path => ({ path, content: arrayBufferToBase64(remote.get(path)!.content), ...remote.get(path)!.entry })) };
		} else if (url.pathname === '/sync/download') {
			const { entry, content } = remote.get(url.searchParams.get('path')!)!;
			return { status: 200, headers: { 'X-File-Hash': entry.hash, 'X-Crate-Revision': entry.revision! }, text: '', arrayBuffer: content.slice(0) };
		} else {
			writes.push(url.pathname);
			throw new Error(`Unexpected request: ${request.url}`);
		}
		const text = JSON.stringify(value);
		return { status: 200, headers: {}, text, arrayBuffer: bytes(text) };
	});
	const harness = await createPersistentEngineHarness(transport, { lastSeq: 0, lastSync: null, automaticSync: false, replaceVault: true, ...overrides });
	await harness.vault.adapter.mkdir('Notes');
	await harness.vault.adapter.mkdir('.git');
	for (const [path, text] of [['note.md', 'local note'], ['Notes/mine.md', 'only here'], ['.git/HEAD', 'ref'],
		['.obsidian/app.json', '{"local":true}'], [`${TEST_PLUGIN_DIR}/data.json`, '{}']] as const) harness.disk.write(path, text);
	return { ...harness, writes };
}

it('replaces a joined vault with the server contents without uploading or creating conflict copies', async () => {
	const h = await joinedVault();

	const result = await h.engine.sync();

	expect(result, result.errors.join('\n')).toMatchObject({ success: true, errors: [], conflicts: [] });
	expect(h.writes).toEqual([]);
	expect(h.disk.text('note.md')).toBe('server note');
	expect(h.disk.text('.obsidian/app.json')).toBe('{"server":true}');
	expect(h.disk.has('Notes/mine.md')).toBe(false);
	expect(h.disk.paths()).toEqual(['note.md']);
	expect([...h.disk.trash.keys()].sort()).toEqual(['.git/HEAD', '.obsidian/app.json', 'Notes/mine.md', 'note.md']);
	expect(h.disk.has(`${TEST_PLUGIN_DIR}/data.json`)).toBe(true);
	expect(h.settings.replaceVault).toBe(false);
});

it('uploads nothing through other sync paths until the replacement ran', async () => {
	const h = await joinedVault();

	const result = await h.engine.forceFullSync();

	expect(result.success).toBe(false);
	expect(result.errors.join('\n')).toContain('Sync now to finish replacing this vault');
	expect(h.writes).toEqual([]);
	expect(h.disk.text('Notes/mine.md')).toBe('only here');
	expect(h.settings.replaceVault).toBe(true);
});

it('never moves a vault that already holds synced files', async () => {
	const h = await joinedVault();
	h.localManifest.setEntry('note.md', { hash: await sha256Hex(bytes('local note')), size: 10, modified: '2026-10-01T00:00:00.000Z', revision: 'r0' });
	await h.localManifest.save();

	await h.engine.sync();

	expect(h.disk.trash.size).toBe(0);
	expect(h.settings.replaceVault).toBe(false);
});
