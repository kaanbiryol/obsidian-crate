export interface PendingChange {
	kind: 'upload' | 'delete';
	path: string;
}

// Queue keys are volatile and reconstructed from local files at startup. NUL
// cannot occur in a sync path, so deletion keys cannot collide with filenames
// such as "delete:note.md". Only this module interprets the key representation.
const DELETE_PREFIX = '\0delete:';

/** A pending change's queue key: an upload's key is its path, a delete's key is not.
 * Decode it with `decodePendingChange` before using it as a path. */
export type PendingKey = string;

export function pendingChangeKey(kind: PendingChange['kind'], path: string): PendingKey {
	return kind === 'delete' ? DELETE_PREFIX + path : path;
}

export function decodePendingChange(key: PendingKey): PendingChange {
	return key.startsWith(DELETE_PREFIX)
		? { kind: 'delete', path: key.slice(DELETE_PREFIX.length) }
		: { kind: 'upload', path: key };
}
