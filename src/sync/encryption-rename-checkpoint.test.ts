import { afterEach, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { LocalManifest } from './manifest';

afterEach(() => vi.restoreAllMocks());
it('recovers a failed checkpoint and never applies a nested folder prefix twice', async () => {
  const disk = new PersistentTestVault();
  const open = () => new LocalManifest({ vault: disk.vault } as App, { dir: TEST_PLUGIN_DIR } as PluginManifest, 'https://test');
  const seed = open(); seed.setEntry('Reading/note.md', { hash: 'f'.repeat(64), size: 1, modified: '2026-01-01T00:00:00Z' }); await seed.save(); await seed.close();
  const moves = [{ id: 'first', from: 'Reading', to: 'Reading/Archive' }, { id: 'second', from: 'Reading/Archive/note.md', to: 'Reading/Archive/renamed.md' }];
  const first = open(); await first.load(); first.applyJournalRenames(moves);
  const real = disk.vault.adapter.write.bind(disk.vault.adapter);
  const fail = vi.spyOn(disk.vault.adapter, 'write').mockImplementation(async (path, value) => { if (path.endsWith('file-manifest.json')) throw new Error('disk full'); await real(path, value); });
  await expect(first.save()).rejects.toThrow('disk full'); await first.close(); fail.mockRestore();
  for (const pending of [moves, moves.slice(1)]) {
    const resumed = open(); await resumed.load(); resumed.applyJournalRenames(pending); await resumed.save();
    expect(resumed.renameDestination('Reading/note.md')).toBe('Reading/Archive/renamed.md'); await resumed.close();
  }
});
it('does not invent a filesystem move when only a folder setting changes', async () => {
  const disk = new PersistentTestVault(), manifest = new LocalManifest({ vault: disk.vault } as App, { dir: TEST_PLUGIN_DIR } as PluginManifest);
  manifest.setEntry('Reading/note.md', { hash: 'f'.repeat(64), size: 1, modified: '2026-01-01T00:00:00Z' });
  manifest.applyJournalRenames([{ id: 'setting', from: 'Reading', to: 'Articles', rename: false }]); await manifest.save();
  expect(manifest.renameDestination('Reading/note.md')).toBeUndefined(); await manifest.close();
});
it('clears a completed round-trip rename so a later intentional deletion is not blocked', async () => {
  const disk = new PersistentTestVault(), manifest = new LocalManifest({ vault: disk.vault } as App, { dir: TEST_PLUGIN_DIR } as PluginManifest);
  manifest.setEntry('Reading/note.md', { hash: 'f'.repeat(64), size: 1, modified: '2026-01-01T00:00:00Z' });
  manifest.recordRename('Reading', 'Articles'); manifest.recordRename('Articles', 'Reading');
  expect(manifest.renameDestination('Reading/note.md')).toBeUndefined();
  await manifest.close();
});
