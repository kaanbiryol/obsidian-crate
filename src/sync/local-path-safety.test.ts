import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from 'obsidian';
import { readLocalFileEntry } from './local-file-entry';
import { deletePathLocallyIfUnchanged } from './planner-helpers';
import { PersistentTestVault } from '../cloudflare/worker/sync-engine-vault-test-harness';

const previous = Platform.isWin;
afterEach(() => { Object.assign(Platform, { isWin: previous }); });
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
