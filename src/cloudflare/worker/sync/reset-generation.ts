/** Survives encryption removal so plaintext authority cannot become valid again. */
export const SYNC_RESET_GENERATION_KEY = 'sync:reset-generation';

/** Public uploads carry the generation read in the authentication query (null
 * before the first reset). Check it in the same transaction as staging/publishing.
 * Internal writes without a snapshot use the coordinator lock or import token. */
export function syncResetGenerationGuard(generation?: string | null): { sql: string; args: string[] } {
	if (generation === undefined) return { sql: '1', args: [] };
	return {
		sql: "COALESCE((SELECT value FROM maintenance_state WHERE key = ?), '') = ?",
		args: [SYNC_RESET_GENERATION_KEY, generation ?? ''],
	};
}
