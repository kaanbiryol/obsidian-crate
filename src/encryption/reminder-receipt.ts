/** Shared with the legacy server contract, for recovering accepted edits whose
 * response was lost before encryption was enabled. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}
export async function reminderRequestHash(action: string, body: Record<string, unknown>): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(canonical({ action, body })));
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
