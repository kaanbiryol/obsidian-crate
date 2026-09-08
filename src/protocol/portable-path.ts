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

export function portablePathKey(path: string): string {
	return path.normalize('NFC').toLowerCase();
}

export interface PortablePathCollision {
	key: string;
	paths: string[];
}

export function findPortablePathCollisions(paths: Iterable<string>): PortablePathCollision[] {
	const pathsByKey = new Map<string, string[]>();
	for (const path of paths) {
		const key = portablePathKey(path);
		const matches = pathsByKey.get(key) ?? [];
		if (!matches.includes(path)) matches.push(path);
		pathsByKey.set(key, matches);
	}
	return [...pathsByKey]
		.filter(([, matches]) => matches.length > 1)
		.map(([key, matches]) => ({ key, paths: matches }));
}

export function assertPortablePaths(paths: Iterable<string>): void {
	const allPaths = [...paths];
	assertPortablePathNames(allPaths);

	const [collision] = findPortablePathCollisions(allPaths);
	if (collision) {
		throw new Error(`Paths collide on a case-insensitive or Unicode-normalizing device: ${collision.paths.join(', ')}`);
	}
	const files = new Map(allPaths.map(path => [portablePathKey(path), path]));
	for (const path of allPaths) {
		const segments = portablePathKey(path).split('/');
		for (let length = 1; length < segments.length; length++) {
			const ancestor = files.get(segments.slice(0, length).join('/'));
			if (ancestor) throw new Error(`File "${ancestor}" conflicts with the parent folder of "${path}". Rename one of these files or its parent folder, then sync again.`);
		}
	}
}

/** Historical changes need valid names, but need not coexist as live files. */
export function assertPortablePathNames(paths: Iterable<string>): void {
	for (const path of paths) {
		const issue = getPortablePathIssue(path);
		if (issue) throw new Error(`Path is not portable across supported devices: ${path} (${issue})`);
	}
}
