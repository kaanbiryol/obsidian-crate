import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../plugin/types';
import { classifyPath } from './reconciliation';

interface Replica {
	files: Map<string, FileEntry>;
	base: Map<string, FileEntry>;
	preserved: string[];
}

interface Server {
	files: Map<string, FileEntry>;
}

function entry(hash: string): FileEntry {
	return { hash, size: hash.length, modified: '2026-01-01T00:00:00.000Z' };
}

function replica(files: Record<string, string>, base: Record<string, string>): Replica {
	return {
		files: new Map(Object.entries(files).map(([path, hash]) => [path, entry(hash)])),
		base: new Map(Object.entries(base).map(([path, hash]) => [path, entry(hash)])),
		preserved: [],
	};
}

function server(files: Record<string, string>): Server {
	return { files: new Map(Object.entries(files).map(([path, hash]) => [path, entry(hash)])) };
}

function hashes(files: Map<string, FileEntry>): Record<string, string> {
	return Object.fromEntries([...files].map(([path, value]) => [path, value.hash]));
}

function synchronizePath(
	client: Replica,
	remote: Server,
	path: string,
	options: { raceBeforeFirstMutation?: () => void } = {},
): void {
	for (let attempt = 0; attempt < 3; attempt++) {
		const localEntry = client.files.get(path);
		const remoteEntry = remote.files.get(path);
		const decision = classifyPath(path, localEntry, remoteEntry, client.base.get(path));
		if (!decision) {
			if (localEntry) client.base.set(path, localEntry);
			else client.base.delete(path);
			return;
		}

		if (attempt === 0) options.raceBeforeFirstMutation?.();
		switch (decision.action) {
			case 'upload': {
				const expectedHash = decision.remoteHash ?? null;
				if ((remote.files.get(path)?.hash ?? null) !== expectedHash) continue;
				const currentLocal = client.files.get(path);
				if (!currentLocal) continue;
				remote.files.set(path, currentLocal);
				client.base.set(path, currentLocal);
				return;
			}
			case 'download': {
				const currentRemote = remote.files.get(path);
				if (!currentRemote || currentRemote.hash !== decision.remoteHash) continue;
				client.files.set(path, currentRemote);
				client.base.set(path, currentRemote);
				return;
			}
			case 'conflict': {
				const currentRemote = remote.files.get(path);
				const currentLocal = client.files.get(path);
				if (!currentRemote || currentRemote.hash !== decision.remoteHash || !currentLocal) continue;
				client.preserved.push(currentLocal.hash);
				client.files.set(path, currentRemote);
				client.base.set(path, currentRemote);
				return;
			}
			case 'delete': {
				if (remote.files.get(path)?.hash !== decision.remoteHash) continue;
				remote.files.delete(path);
				client.base.delete(path);
				return;
			}
			case 'delete-local':
				client.files.delete(path);
				client.base.delete(path);
				return;
		}
	}
	throw new Error(`Reconciliation did not converge for ${path}`);
}

describe('two-device reconciliation state machine', () => {
	it('preserves one side of a concurrent edit while both clients converge', () => {
		const remote = server({ 'note.md': 'base' });
		const first = replica({ 'note.md': 'first-edit' }, { 'note.md': 'base' });
		const second = replica({ 'note.md': 'second-edit' }, { 'note.md': 'base' });

		synchronizePath(first, remote, 'note.md');
		synchronizePath(second, remote, 'note.md');
		synchronizePath(first, remote, 'note.md');

		expect(hashes(remote.files)).toEqual({ 'note.md': 'first-edit' });
		expect(hashes(first.files)).toEqual(hashes(remote.files));
		expect(hashes(second.files)).toEqual(hashes(remote.files));
		expect(second.preserved).toEqual(['second-edit']);
	});

	it.each(['delete-first', 'edit-first'] as const)(
		'keeps edited content through an edit/delete race (%s)',
		(order) => {
			const remote = server({ 'note.md': 'base' });
			const deleting = replica({}, { 'note.md': 'base' });
			const editing = replica({ 'note.md': 'edited' }, { 'note.md': 'base' });

			if (order === 'delete-first') {
				synchronizePath(deleting, remote, 'note.md');
				synchronizePath(editing, remote, 'note.md');
			} else {
				synchronizePath(editing, remote, 'note.md');
				synchronizePath(deleting, remote, 'note.md');
			}
			synchronizePath(deleting, remote, 'note.md');
			synchronizePath(editing, remote, 'note.md');

			expect(hashes(remote.files)).toEqual({ 'note.md': 'edited' });
			expect(hashes(deleting.files)).toEqual(hashes(remote.files));
			expect(hashes(editing.files)).toEqual(hashes(remote.files));
		},
	);

	it('retains both rename and edit outcomes when devices race', () => {
		const remote = server({ 'old.md': 'base' });
		const renaming = replica({ 'new.md': 'base' }, { 'old.md': 'base' });
		const editing = replica({ 'old.md': 'edited' }, { 'old.md': 'base' });

		synchronizePath(renaming, remote, 'old.md');
		synchronizePath(renaming, remote, 'new.md');
		synchronizePath(editing, remote, 'old.md');
		synchronizePath(editing, remote, 'new.md');
		synchronizePath(renaming, remote, 'old.md');

		expect(hashes(remote.files)).toEqual({ 'new.md': 'base', 'old.md': 'edited' });
		expect(hashes(renaming.files)).toEqual(hashes(remote.files));
		expect(hashes(editing.files)).toEqual(hashes(remote.files));
	});

	it('replans a mutation after the remote changes between planning and commit', () => {
		const remote = server({ 'note.md': 'base' });
		const client = replica({ 'note.md': 'local-edit' }, { 'note.md': 'base' });

		synchronizePath(client, remote, 'note.md', {
			raceBeforeFirstMutation: () => remote.files.set('note.md', entry('racing-edit')),
		});

		expect(hashes(remote.files)).toEqual({ 'note.md': 'racing-edit' });
		expect(hashes(client.files)).toEqual(hashes(remote.files));
		expect(client.preserved).toEqual(['local-edit']);
	});
});
