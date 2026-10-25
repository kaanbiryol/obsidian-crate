import { serverStateValue } from '../server-state';

/** Public uploads carry the generation read in the authentication query (null
 * before the first reset). Check it in the same transaction as staging/publishing.
 * Internal writes without a snapshot use the coordinator lock or import token. */
export function syncResetGenerationGuard(generation?: string | null): { sql: string; args: string[] } {
	if (generation === undefined) return { sql: '1', args: [] };
	return {
		sql: `COALESCE(${serverStateValue('reset_generation')}, '') = ?`,
		args: [generation ?? ''],
	};
}
