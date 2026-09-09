import { expect, it, vi } from 'vitest';
import { LocalManifest } from './manifest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/cloudflare/worker/sync-engine-vault-test-harness';

const mainPath = `${TEST_PLUGIN_DIR}/file-manifest.json`, tmpPath = mainPath + '.tmp';
const good = { version: 2, generation: 5, authority: 'server', lastSeq: 10,
	files: { 'note.md': { hash: 'a'.repeat(64), size: 1, modified: '2026-09-09' } } };
function fixture() {
	const disk = new PersistentTestVault();
	const manifest = new LocalManifest({ vault: disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, 'server');
	return { disk, manifest };
}
it.each([
	{ version: 99 }, { version: '2' }, { files: null }, { generation: -1 }, { lastSeq: '10' },
	{ authority: 'foreign' }, { truncated: true }, { settledUploads: ['unknown'] },
	{ files: { ...good.files, 'bad.md': { ...good.files['note.md'], size: 'damaged' } } },
])('preserves both generations when the newer JSON checkpoint is semantically invalid: %j', async patch => {
	const { disk, manifest } = fixture();
	const bytes = JSON.stringify({ ...good, ...patch });
	disk.write(mainPath, bytes); disk.write(tmpPath, JSON.stringify({ ...good, generation: 4 }));
	await expect(manifest.load()).rejects.toThrow();
	expect(disk.text(mainPath)).toBe(bytes);
	expect(disk.text(tmpPath)).toBe(JSON.stringify({ ...good, generation: 4 }));
});
it('rejects a foreign older temporary generation before writing or removing anything', async () => {
	const { disk, manifest } = fixture();
	disk.write(mainPath, JSON.stringify(good)); disk.write(tmpPath, JSON.stringify({ ...good, generation: 4, authority: 'foreign' }));
	const write = vi.spyOn(disk.vault.adapter, 'write'), remove = vi.spyOn(disk.vault.adapter, 'remove');
	await expect(manifest.load()).rejects.toThrow('not bound');
	expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});
it('archives torn JSON before promoting the surviving generation', async () => {
	const { disk, manifest } = fixture();
	disk.write(mainPath, '{"files":'); disk.write(tmpPath, JSON.stringify(good));
	await manifest.load();
	const files = (await disk.vault.adapter.list(TEST_PLUGIN_DIR)).files;
	const archive = files.find(path => path.startsWith(mainPath + '.corrupt-'))!;
	expect(disk.text(archive)).toBe('{"files":');
	expect(manifest.getEntry('note.md')?.hash).toBe(good.files['note.md'].hash);
});
it('does not treat read failures or equal-generation disagreement as an absent checkpoint', async () => {
	const { disk, manifest } = fixture();
	disk.write(mainPath, JSON.stringify(good)); disk.write(tmpPath, JSON.stringify({ ...good, files: {} }));
	await expect(manifest.load()).rejects.toThrow('Conflicting');
	vi.spyOn(disk.vault.adapter, 'read').mockRejectedValue(new Error('Disk unavailable'));
	await expect(manifest.load()).rejects.toThrow('Disk unavailable');
	expect(disk.has(tmpPath)).toBe(true);
});
