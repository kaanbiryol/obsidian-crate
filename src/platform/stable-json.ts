/** Serialize with sorted object keys, so equal values compare equal after a reload or normalization reorders keys. */
export function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
		: item);
}
