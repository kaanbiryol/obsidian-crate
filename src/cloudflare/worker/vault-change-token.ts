import { sha256Hex } from './auth';
import { LAST_SEQ_SQL } from './sync-storage';
import { SYNC_RESET_GENERATION_KEY } from './sync-reset-generation';

/** Every file write advances the changelog, the initial import generation or the
 * reset generation, so an equal token proves no file changed since it was issued.
 * `scope` binds it to the caller's view (for example a folder and parser version). */
export async function vaultChangeToken(db: D1Database, scope: string): Promise<string> {
	const row = await db.prepare(`SELECT ${LAST_SEQ_SQL} AS seq,
		COALESCE((SELECT generation FROM initial_import WHERE id = 1), 0) AS importGeneration,
		COALESCE((SELECT value FROM maintenance_state WHERE key = ?), '') AS resetGeneration`)
		.bind(SYNC_RESET_GENERATION_KEY).first<{ seq: number; importGeneration: number; resetGeneration: string }>();
	return (await sha256Hex(`${scope}\nreset:${row?.resetGeneration}\nimport:${row?.importGeneration}\nseq:${row?.seq}`)).slice(0, 32);
}

/** Two-part ETags: a vault change token, then a revision of the view's content. */
export function parseChangeEtags(header: string | null): Array<{ changeToken: string; revision: string }> {
	return (header?.split(',') ?? []).flatMap(value => {
		const match = /^"([a-f0-9]{32})\.([a-f0-9]{32})"$/.exec(value.trim());
		return match ? [{ changeToken: match[1]!, revision: match[2]! }] : [];
	});
}
