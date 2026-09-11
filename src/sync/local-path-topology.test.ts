import { expect, it, vi } from 'vitest';
import { PersistentTestVault } from '../cloudflare/worker/sync-engine-vault-test-harness';
import { applyRemoteContentIfUnchanged } from './local-apply';
const incoming = new TextEncoder().encode('remote replacement').buffer;

it('removes only empty directory trees before creating their replacement file', async () => {
	const disk = new PersistentTestVault(); await disk.vault.createFolder('Project.md/empty/nested');
	expect(await applyRemoteContentIfUnchanged({vault:disk.vault},'Project.md',incoming,null)).toEqual({status:'applied'});
	expect(disk.read('Project.md')).toEqual(incoming);
});
it.each(['.hidden','ignored.txt','ordinary.md'])('preserves every local child, including %s, and keeps an incoming review copy', async child => {
	const disk = new PersistentTestVault(); await disk.vault.createFolder('Project.md'); disk.write(`Project.md/${child}`,'local');
	const result = await applyRemoteContentIfUnchanged({vault:disk.vault},'Project.md',incoming,null);
	expect(result.status).toBe('deferred'); expect(disk.text(`Project.md/${child}`)).toBe('local');
	expect(disk.paths().some(path=>path.includes('(conflict remote '))).toBe(true);
});
it('a child created after listing prevents non-recursive removal', async () => {
	const disk = new PersistentTestVault(); await disk.vault.createFolder('Project.md');
	const remove = disk.vault.adapter.rmdir.bind(disk.vault.adapter);
	vi.spyOn(disk.vault.adapter,'rmdir').mockImplementationOnce(async (path,recursive) => { disk.write('Project.md/racing.md','new local edit'); return remove(path,recursive); });
	expect((await applyRemoteContentIfUnchanged({vault:disk.vault},'Project.md',incoming,null)).status).toBe('deferred');
	expect(disk.text('Project.md/racing.md')).toBe('new local edit');
});
it('reports an obstructing parent file without overwriting or deleting it', async () => {
	const disk = new PersistentTestVault(); disk.write('Project','local parent');
	const result = await applyRemoteContentIfUnchanged({vault:disk.vault},'Project/note.md',incoming,null);
	expect(result.status).toBe('deferred');
	if (result.status === 'deferred') expect(result.reason).toContain('local file blocks');
	expect(disk.text('Project')).toBe('local parent');
});
it('retains a folder when the host refuses removal and retries safely later', async () => {
	const disk = new PersistentTestVault(); await disk.vault.createFolder('Project.md');
	vi.spyOn(disk.vault.adapter,'rmdir').mockRejectedValueOnce(new Error('Permission denied'));
	expect((await applyRemoteContentIfUnchanged({vault:disk.vault},'Project.md',incoming,null)).status).toBe('deferred');
	expect((await applyRemoteContentIfUnchanged({vault:disk.vault},'Project.md',incoming,null)).status).toBe('applied');
	expect(disk.read('Project.md')).toEqual(incoming);
});
