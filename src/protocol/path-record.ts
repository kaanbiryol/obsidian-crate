/** File paths may be names such as __proto__, constructor, or toString. */
export function createPathRecord<T>(entries?: Readonly<Record<string, T>>): Record<string, T> {
	return Object.assign(Object.create(null) as Record<string, T>, entries);
}

/** Also accept plain JSON records without treating inherited names as files. */
export function getPathEntry<T>(entries: Readonly<Record<string, T>>, path: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(entries, path) ? entries[path] : undefined;
}
