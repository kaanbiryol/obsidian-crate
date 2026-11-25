import { describe, expect, it, vi } from 'vitest';
import { PersistentTestVault } from '@/test/factories/sync-vault';
import { sha256Hex } from '@/platform/sha256';
import { moveUnchangedLocalFile } from './local-move';
import type { TransferContext } from '../transfer/types';

function setup() {
	const disk = new PersistentTestVault();
	const setEntry = vi.fn();
	const context = {
		vault: disk.vault,
		localManifest: { setEntry },
		markdownBaseCache: { putBase: vi.fn(async () => {}) },
		conflictStore: { resolveAppliedIncoming: vi.fn(async () => {}) },
		files: { recordMergeApplication: vi.fn(async () => {}) },
		getModifiedIso: async () => '2026-11-25T00:00:00.000Z',
	} as unknown as TransferContext;
	return { disk, context, setEntry };
}

describe('moveUnchangedLocalFile', () => {
	it('moves an unchanged file into a new folder and records it as applied', async () => {
		const { disk, context, setEntry } = setup();
		disk.write('note.md', 'Moved');
		const hash = await sha256Hex(disk.read('note.md'));
		expect(await moveUnchangedLocalFile(context, 'note.md', 'Archive/note.md', hash, 'rev-1')).toBe(true);
		expect(disk.has('note.md')).toBe(false);
		expect(disk.text('Archive/note.md')).toBe('Moved');
		expect(setEntry).toHaveBeenCalledWith('Archive/note.md', expect.objectContaining({ hash, size: 5, revision: 'rev-1' }));
		expect(disk.trash.size).toBe(0);
	});

	it('leaves a changed source, a taken target or a missing source to the delete and download', async () => {
		const { disk, context, setEntry } = setup();
		disk.write('edited.md', 'Edited');
		disk.write('a.md', 'A');
		disk.write('b.md', 'B');
		const hashOf = async (path: string) => sha256Hex(disk.read(path));
		expect(await moveUnchangedLocalFile(context, 'edited.md', 'new.md', await sha256Hex(new TextEncoder().encode('Original').buffer))).toBe(false);
		expect(await moveUnchangedLocalFile(context, 'a.md', 'b.md', await hashOf('a.md'))).toBe(false);
		expect(await moveUnchangedLocalFile(context, 'gone.md', 'new.md', await hashOf('a.md'))).toBe(false);
		expect(await moveUnchangedLocalFile(context, 'a.md', '.hidden/a.md', await hashOf('a.md'))).toBe(false);
		expect(disk.text('edited.md')).toBe('Edited');
		expect(disk.text('b.md')).toBe('B');
		expect(setEntry).not.toHaveBeenCalled();
	});
});
