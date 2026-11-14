const marked = new WeakMap<DurableObjectState, Set<string>>();

/** Stores a role's flag once per object activation, for a runtime that withholds an
 * instance's name from its alarm (`coordinator-alarms.ts`); later arms write nothing. */
export async function markRole(state: DurableObjectState, key: string): Promise<void> {
	const keys = marked.get(state) ?? new Set<string>();
	if (keys.has(key)) return;
	await state.storage.put(key, true);
	keys.add(key);
	marked.set(state, keys);
}
