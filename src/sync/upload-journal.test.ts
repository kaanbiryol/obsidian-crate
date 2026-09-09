import { expect, it, vi } from 'vitest';
import { LocalManifest } from './manifest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/cloudflare/worker/sync-engine-vault-test-harness';

function fixture() {
	const disk = new PersistentTestVault();
	const create = (authority = 'https://server.test') => new LocalManifest({ vault: disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, authority);
	const file = { intent: { kind: 'local' as const }, path: 'note.md', content: btoa('original'), hash: '0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5', size: 8, contentType: 'text/markdown', expectedHash: null };
	return { disk, create, file };
}

it('preserves settled receipts while promoting a newer temporary checkpoint across repeated crashes', async () => {
	const { disk, create, file } = fixture();
	const manifest = create();
	const [upload] = await manifest.uploadJournal.prepare([file], 20000);
	manifest.setEntry(file.path, { hash: file.hash, size: file.size, revision: 'revision', modified: '2026-09-09T00:00:00Z' });
	manifest.completeUpload(upload!.operationId);
	const write = disk.vault.adapter.write.bind(disk.vault.adapter);
	const fail = vi.spyOn(disk.vault.adapter, 'write').mockImplementation(async (path, bytes) => {
		if (path.endsWith('/file-manifest.json')) throw new Error('Main checkpoint unavailable');
		await write(path, bytes);
	});
	await expect(manifest.save()).rejects.toThrow('Main checkpoint unavailable');
	await manifest.close(); fail.mockRestore();
	const recovered = create(); await recovered.load();
	expect(recovered.uploadJournal.pending()).toEqual([]);
	expect(JSON.parse(disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`))).toMatchObject({ settledUploads: [upload!.operationId] });
	await recovered.close();
	const again = create(); await again.load();
	expect(again.uploadJournal.pending()).toEqual([]);
	expect(again.getEntry(file.path)?.revision).toBe('revision');
});

it('refuses a foreign or torn journal without deleting its only copy', async () => {
	const { disk, create, file } = fixture();
	const manifest = create();
	const [upload] = await manifest.uploadJournal.prepare([file], 20000);
	const path = `${TEST_PLUGIN_DIR}/pending-uploads/${upload!.operationId}.json`;
	await expect(create('https://another.test').load()).rejects.toThrow('another server');
	expect(disk.has(path)).toBe(true);
	disk.write(path, '{"truncated":');
	await expect(create().load()).rejects.toThrow('Unreadable upload journal');
	expect(disk.text(path)).toBe('{"truncated":');
});


it('drops already-pruned receipt IDs on restart instead of accumulating them forever', async () => {
	const { create, file, disk } = fixture();
	const manifest = create();
	const [upload] = await manifest.uploadJournal.prepare([file], 20000);
	manifest.setEntry(file.path, { hash: file.hash, size: file.size, revision: 'revision', modified: '2026-09-09T00:00:00Z' });
	manifest.completeUpload(upload!.operationId);
	await manifest.save(); await manifest.close();
	const reopened = create(); await reopened.load();
	expect(reopened.uploadJournal.completedSnapshot()).toEqual([]);
	reopened.setEntry(file.path, { ...reopened.getEntry(file.path)!, modified: '2026-09-10T00:00:00Z' });
	await reopened.save();
	expect(JSON.parse(disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`))).not.toHaveProperty('settledUploads');
});

it.each(['legacy', 'unknown-intent', 'damaged-content', 'damaged-preimage'])('preserves and refuses an unsafe %s upload record', async failure => {
	const { disk, create, file } = fixture();
	const [upload] = await create().uploadJournal.prepare([file], 20000);
	const path = `${TEST_PLUGIN_DIR}/pending-uploads/${upload!.operationId}.json`;
	const raw = JSON.parse(disk.text(path)) as { version?: number; file: Record<string, unknown> };
	if (failure === 'legacy') delete raw.version;
	if (failure === 'unknown-intent') raw.file.intent = { kind: 'future' };
	if (failure === 'damaged-content') raw.file.content = btoa('tampered');
	if (failure === 'damaged-preimage') raw.file.intent = { kind: 'merge', preimage: { content: btoa('damaged'), hash: file.hash, size: file.size } };
	const bytes = JSON.stringify(raw); disk.write(path, bytes);
	await expect(create().load()).rejects.toThrow();
	expect(disk.text(path)).toBe(bytes);
});
