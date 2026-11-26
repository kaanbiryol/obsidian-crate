/** A stand-in for `IDBKeyRange` over string keys, which IndexedDB orders by UTF-16 code
 * units as JavaScript compares them. Stub it with `vi.stubGlobal('IDBKeyRange', fakeKeyRange)`. */
export interface FakeKeyRange { lower: string; upper: string; includes(key: string): boolean }

export const fakeKeyRange = {
	bound: (lower: string, upper: string, lowerOpen = false, upperOpen = false): FakeKeyRange => ({
		lower, upper,
		includes: key => (lowerOpen ? key > lower : key >= lower) && (upperOpen ? key < upper : key <= upper),
	}),
};

/** The keys a fake store's `getAllKeys(range)` answers. A whole-store scan has no range and fails. */
export function keysInRange(keys: Iterable<string>, range: FakeKeyRange | undefined): string[] {
	if (!range) throw new Error('Expected a key range, not a whole-store scan');
	return [...keys].filter(key => range.includes(key));
}
