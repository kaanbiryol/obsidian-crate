/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';
import { OWN_FIRST_UPLOAD_UNFINISHED } from '../../../sync/engine/initial-import';
import { vaultEntry } from '../../../sync/runtime/vault-event-gate';

// Sync activity's Sync button leaves unchecked files alone in both directions.

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
});
afterEach(async () => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

async function device(id: string): Promise<SyncTestDevice> {
	const client = new SyncTestDevice(id, env); clients.push(client);
	await client.authorize(); await client.open();
	return client;
}

const serverPaths = async () => (await env.DB.prepare('SELECT path FROM files ORDER BY path').all<{ path: string }>()).results.map(row => row.path);
const serverText = async (client: SyncTestDevice, path: string) => new TextDecoder().decode((await client.api.downloadFile(path)).content);

it('leaves unchecked files out of a first upload and uploads them on a later sync', async () => {
	const first = await device('held-import');
	first.disk.write('keep.md', 'keep');
	first.disk.write('draft.md', 'draft');

	const held = await first.engine.sync(undefined, { held: ['draft.md'] });
	expect(held).toMatchObject({ success: true, uploaded: 1, errors: [] });
	expect(await serverPaths()).toEqual(['keep.md']);
	// The first upload finished: the vault is set up and other devices may join.
	expect(first.settings.lastSeq).toBeGreaterThan(0);
	expect(first.checkpoint().files['draft.md']).toBeUndefined();

	const second = await device('held-import-joiner');
	expect((await second.engine.sync()).errors).toEqual([]);
	expect(second.disk.has('draft.md')).toBe(false);

	expect((await first.engine.sync()).errors).toEqual([]);
	expect(await serverPaths()).toEqual(['draft.md', 'keep.md']);
	expect(first.disk.text('draft.md')).toBe('draft');
	expect(first.disk.trash.size).toBe(0);
	expect((await second.engine.sync()).errors).toEqual([]);
	expect(second.disk.text('draft.md')).toBe('draft');
});

it('keeps an unchecked file\'s server copy when a resumed first upload leaves it out', async () => {
	const first = await device('held-resume');
	first.disk.write('keep.md', 'keep');
	first.disk.write('draft.md', 'draft');
	vi.spyOn(first.api.initialImport, 'finish').mockRejectedValueOnce(new Error('offline'));
	expect((await first.engine.sync()).success).toBe(false);
	expect(await serverPaths()).toEqual(['draft.md', 'keep.md']);

	// The resumed upload neither prunes nor replaces the unchecked file.
	first.disk.write('draft.md', 'draft, edited');
	expect(await first.engine.sync(undefined, { held: ['draft.md'] })).toMatchObject({ success: true, errors: [] });
	expect(await serverPaths()).toEqual(['draft.md', 'keep.md']);
	expect(await serverText(first, 'draft.md')).toBe('draft');
	expect(first.disk.text('draft.md')).toBe('draft, edited');

	expect((await first.engine.sync()).errors).toEqual([]);
	expect(await serverText(first, 'draft.md')).toBe('draft, edited');
});

it('gets other remote changes but leaves an unchecked file and its remote edit alone', async () => {
	const writer = await device('held-writer');
	writer.disk.write('shared.md', 'one\ntwo\nthree\n');
	writer.disk.write('other.md', 'before');
	expect((await writer.engine.sync()).errors).toEqual([]);
	const reader = await device('held-reader');
	expect((await reader.engine.sync()).errors).toEqual([]);

	writer.disk.write('shared.md', 'ONE\ntwo\nthree\n');
	writer.disk.write('other.md', 'after');
	expect((await writer.engine.sync()).errors).toEqual([]);
	reader.disk.write('shared.md', 'one\ntwo\nTHREE\n');

	const held = await reader.engine.sync(undefined, { held: ['shared.md'] });
	expect(held).toMatchObject({ success: true, uploaded: 0, merged: 0, conflicts: [], errors: [] });
	expect(reader.disk.text('other.md')).toBe('after');
	expect(reader.disk.text('shared.md')).toBe('one\ntwo\nTHREE\n');
	expect(await serverText(reader, 'shared.md')).toBe('ONE\ntwo\nthree\n');

	// Syncing the file later merges both edits as any concurrent edit would.
	expect((await reader.engine.sync()).errors).toEqual([]);
	expect(reader.disk.text('shared.md')).toBe('ONE\ntwo\nTHREE\n');
	expect(await serverText(reader, 'shared.md')).toBe('ONE\ntwo\nTHREE\n');
});

it('finds a skipped remote edit after the unchecked local change is undone', async () => {
	const writer = await device('discard-writer');
	writer.disk.write('shared.md', 'base');
	expect((await writer.engine.sync()).errors).toEqual([]);
	const reader = await device('discard-reader');
	expect((await reader.engine.sync()).errors).toEqual([]);

	writer.disk.write('shared.md', 'remote edit');
	expect((await writer.engine.sync()).errors).toEqual([]);
	reader.disk.write('shared.md', 'local edit');
	expect((await reader.engine.sync(undefined, { held: ['shared.md'] })).errors).toEqual([]);
	expect(reader.settings.fullSyncRequested).toBe(true);

	// Undoing the local edit leaves nothing to upload, and the cursor is past the remote
	// edit. Before: incremental sync never looked at the file again.
	reader.disk.write('shared.md', 'base');
	expect((await reader.engine.sync()).errors).toEqual([]);
	expect(reader.disk.text('shared.md')).toBe('remote edit');
	expect(reader.settings.fullSyncRequested).toBeUndefined();
});

it('tells the device that owns an unfinished first upload to sync again', async () => {
	const first = await device('own-import');
	first.settings.automaticSync = true; first.settings.debounceDelay = 0;
	first.disk.write('a.md', 'alpha');
	first.engine.onFileChange(vaultEntry(first.disk.vault.getAbstractFileByPath('a.md')!));
	await vi.waitFor(() => expect(first.engine.getState().lastError).toContain(OWN_FIRST_UPLOAD_UNFINISHED), { timeout: 10_000 });

	first.settings.automaticSync = false;
	expect((await first.engine.sync()).errors).toEqual([]);
	expect(await serverPaths()).toEqual(['a.md']);
});

it('holds a renamed file\'s old name with its unchecked new name and still deletes other files', async () => {
	const client = await device('held-rename');
	client.disk.write('old.md', 'renamed');
	client.disk.write('other.md', 'other');
	expect((await client.engine.sync()).errors).toEqual([]);

	client.disk.rename('old.md', 'new.md');
	client.engine.onFileRename(vaultEntry(client.disk.vault.getAbstractFileByPath('new.md')!), 'old.md');
	client.disk.remove('other.md');
	client.engine.onFileDelete({ path: 'other.md' } as never);

	expect(await client.engine.sync(undefined, { held: ['new.md'] })).toMatchObject({ success: true, errors: [] });
	// The old name waits for its new name, so the server keeps a copy of the file.
	expect(await serverPaths()).toEqual(['old.md']);
	expect((await client.engine.sync()).errors).toEqual([]);
	expect(await serverPaths()).toEqual(['new.md']);
});
