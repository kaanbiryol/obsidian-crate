const MAX_CACHED_TEXT_BYTES = 16 * 1024 * 1024;

/** Evicts the oldest decrypted notes once their text exceeds 16 MiB or the entry limit. */
export function trimContentCache<K, V extends { content: string }>(cache: Map<K, V>, maxEntries: number): void {
	let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.content.length * 2, 0);
	while (bytes > MAX_CACHED_TEXT_BYTES || cache.size > maxEntries) {
		const [oldest, entry] = cache.entries().next().value!;
		bytes -= entry.content.length * 2;
		cache.delete(oldest);
	}
}
