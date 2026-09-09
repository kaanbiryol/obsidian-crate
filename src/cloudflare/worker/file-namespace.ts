import { portablePathKey } from '../../protocol/portable-path';
import { corsResponse } from './cors';

export function namespacePredicate(path: string): { sql: string; args: string[] } {
	const key = portablePathKey(path);
	const prefixLengths: number[] = [];
	let length = 0;
	// SQLite substr counts Unicode code points. Binding lengths rather than
	// complete prefixes also keeps deeply nested path parameters linear in size.
	for (const character of key) {
		if (character === '/') prefixLengths.push(length);
		length++;
	}
	prefixLengths.push(length);
	return {
		// Both lookups use files_portable_path_idx. The half-open range includes
		// descendants of key + '/' without matching siblings such as key + '-x'.
		sql: `path != ? AND (portable_path IN (SELECT substr(?, 1, value) FROM json_each(?))
			OR (portable_path >= ? AND portable_path < ?))`,
		args: [path, key, JSON.stringify(prefixLengths), `${key}/`, `${key}0`],
	};
}

/** Evaluate inside the publication statement, never as a separate preflight. */
export function fileNamespaceGuard(path: string): { sql: string; args: string[] } {
	const predicate = namespacePredicate(path);
	return { sql: `NOT EXISTS (SELECT 1 FROM files WHERE ${predicate.sql})`, args: predicate.args };
}

export class FileNamespaceConflictError extends Error {
	readonly code = 'namespace_conflict';
	constructor(readonly path: string, readonly conflictingPath: string) {
		super(`Cannot sync "${path}" because it conflicts with "${conflictingPath}". Rename one of these files or its parent folder, then sync again.`);
		this.name = 'FileNamespaceConflictError';
	}

	toResponse(): Response {
		return corsResponse({ success: false, path: this.path, error: this.message, code: this.code, conflictingPath: this.conflictingPath }, 409);
	}
}

/** Explain a rejected publication. This query does not authorize the write. */
export async function assertFileNamespaceAvailable(db: D1Database, path: string): Promise<void> {
	const predicate = namespacePredicate(path);
	const conflict = await db.prepare(`SELECT path FROM files WHERE ${predicate.sql} LIMIT 1`)
		.bind(...predicate.args).first<{ path: string }>();
	if (conflict) throw new FileNamespaceConflictError(path, conflict.path);
}
