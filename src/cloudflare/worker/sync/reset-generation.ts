import { serverStateValue } from '../d1/server-state';
import type { SqlGuard } from '../d1/db';

/** Public uploads carry the generation read in the authentication query (null
 * before the first reset). Check it in the same transaction as staging/publishing.
 * Internal writes without a snapshot use the coordinator lock or import token. */
export function syncResetGenerationGuard(generation?: string | null): SqlGuard {
	if (generation === undefined) return { sql: '1', args: [] };
	return {
		sql: `COALESCE(${serverStateValue('reset_generation')}, '') = ?`,
		args: [generation ?? ''],
	};
}
