import { portablePathKey } from '../protocol/portable-path';

/**
 * Builds a lookup for the indexed path the server cannot store beside a given
 * one, as the Worker's namespace guard decides: a path differing from it only in
 * letter case or Unicode form, a file at one of its folders, or a file inside it.
 */
export function namespaceConflictLookup(paths: Iterable<string>): (path: string) => string | undefined {
	const byKey = new Map<string, string[]>();
	const byFolder = new Map<string, string>();
	for (const path of paths) {
		const key = portablePathKey(path);
		const variants = byKey.get(key);
		if (variants) variants.push(path);
		else byKey.set(key, [path]);
		for (let slash = key.indexOf('/'); slash > 0; slash = key.indexOf('/', slash + 1)) {
			const folder = key.slice(0, slash);
			if (!byFolder.has(folder)) byFolder.set(folder, path);
		}
	}
	return path => {
		const key = portablePathKey(path);
		const conflict = byKey.get(key)?.find(other => other !== path) ?? byFolder.get(key);
		if (conflict !== undefined) return conflict;
		for (let slash = key.indexOf('/'); slash > 0; slash = key.indexOf('/', slash + 1)) {
			const file = byKey.get(key.slice(0, slash))?.[0];
			if (file !== undefined) return file;
		}
		return undefined;
	};
}
