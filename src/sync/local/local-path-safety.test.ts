import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from 'obsidian';
import { readLocalFileEntry } from './local-file-entry';
import { deletePathLocallyIfUnchanged } from './local-delete';
import { unsupportedLocalPathIssue } from './local-path-safety';
import { PersistentTestVault } from '@/test/factories/sync-vault';

const previous = { isWin: Platform.isWin, isAndroidApp: Platform.isAndroidApp };
afterEach(() => { Object.assign(Platform, previous); });
it.each(['notes/file.', 'notes/file ', 'notes/file:stream', 'notes/CON.md'])('rejects Windows-incompatible access before reading or deleting: %s', async path => {
 Object.assign(Platform, { isWin: true });
 const disk = new PersistentTestVault();
 const exists = vi.spyOn(disk.vault.adapter, 'exists');
 const read = vi.spyOn(disk.vault.adapter, 'readBinary');
 const trash = vi.spyOn(disk.vault.adapter, 'trashLocal');
 await expect(readLocalFileEntry(disk.vault, path)).rejects.toThrow('on this Windows device');
 await expect(deletePathLocallyIfUnchanged({ vault: disk.vault }, path, 'hash')).rejects.toThrow('on this Windows device');
 expect(exists).not.toHaveBeenCalled();
 expect(read).not.toHaveBeenCalled();
 expect(trash).not.toHaveBeenCalled();
});
it('skips names Android shared storage cannot store, but not Windows-only restrictions', () => {
	Object.assign(Platform, { isAndroidApp: true });
	for (const path of ['notes/a:b.md', 'notes/what?.md', 'notes/a|b.png']) {
		const issue = unsupportedLocalPathIssue(path);
		expect(issue).toMatchObject({ path, code: 'unsupported-device-path' });
		expect(issue?.message).toContain('on this Android device: contains a character that is not supported on Android');
	}
	for (const path of ['notes/CON.md', 'notes/file.', 'notes/plain.md']) expect(unsupportedLocalPathIssue(path)).toBeNull();
});
