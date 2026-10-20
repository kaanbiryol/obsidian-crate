import { expect, it } from 'vitest';
import { getSyncPathIssue } from '../../protocol/portable-path';
import { decodePendingChange, pendingChangeKey } from './pending-change';

it('keeps operation keys distinct for native paths that resemble deletion markers', () => {
	const paths = ['note.md', 'delete:note.md', 'delete:delete:note.md', 'delete:folder/note.md', 'ü/notes.md'];
	const keys = new Set<string>();
	for (const path of paths) {
		expect(getSyncPathIssue(path)).toBeNull();
		for (const kind of ['upload', 'delete'] as const) {
			const key = pendingChangeKey(kind, path);
			expect(keys.has(key)).toBe(false);
			keys.add(key);
			expect(decodePendingChange(key)).toEqual({ kind, path });
		}
	}
});
