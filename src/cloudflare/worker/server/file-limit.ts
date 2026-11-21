import { parseMaxFileBytes } from '../../../protocol/sync-limits';
import type { Env } from '../types';

/** The largest file this server accepts. Only a self-hosted server sets `CRATE_MAX_FILE_BYTES`;
 * stored files stay readable up to the configurable ceiling if the limit is lowered later. */
export function maxFileBytes(env: Pick<Env, 'CRATE_MAX_FILE_BYTES'>): number {
	return parseMaxFileBytes(env.CRATE_MAX_FILE_BYTES);
}
