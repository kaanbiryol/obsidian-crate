const WINDOWS_INVALID_SEGMENT_CHARACTERS = /[<>:"\\|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function getPortablePathIssue(path: string): string | null {
	for (const segment of path.split('/')) {
		if (WINDOWS_INVALID_SEGMENT_CHARACTERS.test(segment)) {
			return 'contains a character that is not supported on Windows';
		}
		if (/[. ]$/u.test(segment)) {
			return 'contains a segment ending in a dot or space';
		}
		if (WINDOWS_RESERVED_NAME.test(segment)) {
			return `contains the reserved name "${segment}"`;
		}
	}
	return null;
}

/** Android shared storage rejects the characters FAT cannot store, but not Windows'
 * reserved names or trailing dots and spaces. */
export function getAndroidPathIssue(path: string): string | null {
	return path.split('/').some(segment => WINDOWS_INVALID_SEGMENT_CHARACTERS.test(segment))
		? 'contains a character that is not supported on Android' : null;
}

/** Sync storage accepts native filenames; device restrictions belong at local writes. */
export function getSyncPathIssue(path: string): string | null {
	if (!path || path.length > 1024) return 'path is empty or too long';
	// eslint-disable-next-line no-control-regex -- Reject unsafe protocol paths.
	if (/[\u0000-\u001f\u007f\\]/u.test(path)) return 'contains a control character or backslash';
	if (path.split('/').some(segment => !segment || segment === '.' || segment === '..')) return 'contains an invalid path segment';
	return null;
}

/** UTF-8 byte order, as the server's binary collation sorts paths: surrogate pairs
 * encode code points above every BMP character. */
export function compareCodePoints(a: string, b: string): number {
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		const left = a.charCodeAt(index), right = b.charCodeAt(index);
		if (left === right) continue;
		const rank = (unit: number) => unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit;
		return rank(left) - rank(right);
	}
	return a.length - b.length;
}

export function portablePathKey(path: string): string {
	return path.normalize('NFC').toLowerCase();
}

/** Rejects invalid names and paths that collide on a case-insensitive or
 * Unicode-normalizing device, then a file that is also another path's folder. */
export function assertPortablePaths(paths: Iterable<string>): void {
	const files = new Map<string, string>();
	for (const path of paths) {
		const issue = getSyncPathIssue(path);
		if (issue) throw new Error(`Invalid sync path: ${path} (${issue})`);
		const key = portablePathKey(path);
		const prior = files.get(key);
		if (prior !== undefined && prior !== path) {
			throw new Error(`Paths collide on a case-insensitive or Unicode-normalizing device: ${prior}, ${path}`);
		}
		files.set(key, path);
	}
	for (const [key, path] of files) {
		for (let slash = key.indexOf('/'); slash > 0; slash = key.indexOf('/', slash + 1)) {
			const ancestor = files.get(key.slice(0, slash));
			if (ancestor) throw new Error(`File "${ancestor}" conflicts with the parent folder of "${path}". Rename one of these files or its parent folder, then sync again.`);
		}
	}
}

/** Each folder key above `key`, nearest the root first. */
function ancestorKeys(key: string): string[] {
	const ancestors: string[] = [];
	for (let slash = key.indexOf('/'); slash > 0; slash = key.indexOf('/', slash + 1)) ancestors.push(key.slice(0, slash));
	return ancestors;
}

/**
 * `assertPortablePaths` for successive snapshots of one file set, such as a vault's files
 * at each scan. Paths accepted earlier were checked against every other accepted path, so
 * only paths added since the last snapshot are checked, against the paths kept. A snapshot
 * that fails is checked in full for the same error, and the next one starts over.
 */
export class PortablePathSet {
	private readonly keyByPath = new Map<string, string>();
	private readonly pathByKey = new Map<string, string>();
	/** Folder keys above accepted files, with the number of files below each. */
	private readonly folderFiles = new Map<string, number>();

	assert(paths: Iterable<string>): void {
		const current = new Set(paths);
		for (const [path, key] of this.keyByPath) if (!current.has(path)) this.remove(path, key);
		for (const path of current) {
			if (this.keyByPath.has(path)) continue;
			const key = getSyncPathIssue(path) ? undefined : portablePathKey(path);
			const folders = key === undefined ? [] : ancestorKeys(key);
			if (key === undefined || this.pathByKey.has(key) || this.folderFiles.has(key) || folders.some(folder => this.pathByKey.has(folder))) {
				this.clear();
				assertPortablePaths(current);
				throw new Error(`Invalid sync path: ${path}`);
			}
			this.keyByPath.set(path, key);
			this.pathByKey.set(key, path);
			for (const folder of folders) this.folderFiles.set(folder, (this.folderFiles.get(folder) ?? 0) + 1);
		}
	}

	private remove(path: string, key: string): void {
		this.keyByPath.delete(path);
		this.pathByKey.delete(key);
		for (const folder of ancestorKeys(key)) {
			const count = this.folderFiles.get(folder)! - 1;
			if (count) this.folderFiles.set(folder, count); else this.folderFiles.delete(folder);
		}
	}

	private clear(): void {
		this.keyByPath.clear();
		this.pathByKey.clear();
		this.folderFiles.clear();
	}
}

/** Historical changes need valid names, but need not coexist as live files. */
export function assertPortablePathNames(paths: Iterable<string>): void {
	for (const path of paths) {
		const issue = getSyncPathIssue(path);
		if (issue) throw new Error(`Invalid sync path: ${path} (${issue})`);
	}
}
