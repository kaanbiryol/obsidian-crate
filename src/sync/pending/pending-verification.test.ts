import { describe, expect, it, vi } from 'vitest';
import { verifyUnchangedPendingPaths } from './pending-verification';
import { pendingChangeKey } from './pending-change';
import { sha256Hex } from '../../platform/sha256';
import type { FileEntry } from '../../protocol/sync-types';

async function harness(content: string, baselineContent: string) {
	const bytes = new TextEncoder().encode(content);
	const baseline: FileEntry = { hash: await sha256Hex(new TextEncoder().encode(baselineContent).buffer), size: new TextEncoder().encode(baselineContent).byteLength, modified: 'unverified' };
	const adapter = {
		stat: vi.fn(async () => ({ type: 'file' as const, size: bytes.byteLength, mtime: 1_000, ctime: 0 })),
		readBinary: vi.fn(async () => bytes.slice().buffer),
	};
	const manifest = { getEntry: () => baseline, setEntry: vi.fn(), save: vi.fn(async () => {}) };
	return { adapter, manifest, run: () => verifyUnchangedPendingPaths({ adapter, manifest, isCurrent: () => true }, [pendingChangeKey('upload', 'note.md')]) };
}

describe('verifyUnchangedPendingPaths', () => {
	it('settles a file whose bytes still match its baseline', async () => {
		const { run, manifest } = await harness('same', 'same');
		expect(await run()).toEqual(['note.md']);
		expect(manifest.setEntry).toHaveBeenCalledWith('note.md', expect.objectContaining({ modified: new Date(1_000).toISOString() }));
	});

	it('leaves a file of a different size pending without reading it', async () => {
		const { run, adapter } = await harness('grown content', 'short');
		expect(await run()).toEqual([]);
		expect(adapter.readBinary).not.toHaveBeenCalled();
	});

	it('leaves a file of the same size with other bytes pending', async () => {
		const { run, adapter } = await harness('abcd', 'wxyz');
		expect(await run()).toEqual([]);
		expect(adapter.readBinary).toHaveBeenCalledOnce();
	});
});
