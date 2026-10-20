export interface PendingChange {
	kind: 'upload' | 'delete';
	path: string;
}

// Queue keys are volatile and reconstructed from local files at startup. NUL
// cannot occur in a sync path, so deletion keys cannot collide with filenames
// such as "delete:note.md". Only this module interprets the key representation.
const DELETE_PREFIX = '\0delete:';

export function pendingChangeKey(kind: PendingChange['kind'], path: string): string {
	return kind === 'delete' ? DELETE_PREFIX + path : path;
}

export function decodePendingChange(key: string): PendingChange {
	return key.startsWith(DELETE_PREFIX)
		? { kind: 'delete', path: key.slice(DELETE_PREFIX.length) }
		: { kind: 'upload', path: key };
}
