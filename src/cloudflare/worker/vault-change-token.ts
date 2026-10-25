import { getChangelogBounds, LAST_SEQ_SQL } from './sync/storage';
import { serverStateValue } from './server-state';
import { sha256Hex } from '../../platform/sha256';

export interface VaultChangeState { seq: number; importGeneration: number; resetGeneration: string }

export async function readVaultChangeState(db: D1Database): Promise<VaultChangeState> {
	const row = await db.prepare(`SELECT ${LAST_SEQ_SQL} AS seq,
		COALESCE((SELECT generation FROM initial_import WHERE id = 1), 0) AS importGeneration,
		COALESCE(${serverStateValue('reset_generation')}, '') AS resetGeneration`).first<VaultChangeState>();
	return { seq: row?.seq ?? 0, importGeneration: row?.importGeneration ?? 0, resetGeneration: row?.resetGeneration ?? '' };
}

/** Every file write advances the changelog, the initial import generation or the
 * reset generation, so an equal token proves no file changed since it was issued.
 * `scope` binds it to the caller's view (for example a folder and parser version). */
export async function vaultChangeToken(db: D1Database, scope: string, state?: VaultChangeState): Promise<string> {
	const current = state ?? await readVaultChangeState(db);
	return (await sha256Hex(`${scope}\nreset:${current.resetGeneration}\nimport:${current.importGeneration}\nseq:${current.seq}`)).slice(0, 32);
}

/** Two-part ETags: a vault change token, then a revision of the view's content. */
export function parseChangeEtags(header: string | null): Array<{ changeToken: string; revision: string }> {
	return (header?.split(',') ?? []).flatMap(value => {
		const match = /^"([a-f0-9]{32})\.([a-f0-9]{32})"$/.exec(value.trim());
		return match ? [{ changeToken: match[1]!, revision: match[2]! }] : [];
	});
}

/** A changelog position plus everything that would invalidate replaying from it:
 * the view, an initial import and a destructive reset. */
export async function deltaBase(scope: string, state: VaultChangeState): Promise<string> {
	return `${state.seq}.${(await sha256Hex(`${scope}\nreset:${state.resetGeneration}\nimport:${state.importGeneration}`)).slice(0, 32)}`;
}

export function parseDeltaBase(value: string | null): { seq: number; scope: string } | null {
	const match = value ? /^(\d{1,15})\.([a-f0-9]{32})$/.exec(value) : null;
	return match ? { seq: Number(match[1]), scope: match[2]! } : null;
}

// Beyond this many vault changes a full response is cheaper than the replay.
const MAX_DELTA_CHANGES = 20_000;

/** Paths in `folderPath` written or deleted after `seq`, or null when the
 * changelog cannot prove completeness (pruned, imported, or too many changes). */
export async function changedPathsSince(db: D1Database, folderPath: string, seq: number): Promise<string[] | null> {
	const bounds = await getChangelogBounds(db);
	// Retained sequence numbers are contiguous, so this bounds the rows to replay.
	if (seq > bounds.lastSeq || seq < bounds.snapshotSeq || (bounds.minSeq !== null && seq < bounds.minSeq - 1)
		|| bounds.lastSeq - seq > MAX_DELTA_CHANGES) return null;
	const rows = await db.prepare('SELECT DISTINCT path FROM changelog WHERE seq > ? AND path >= ? AND path < ?')
		.bind(seq, `${folderPath}/`, `${folderPath}0`).all<{ path: string }>();
	return rows.results.map(row => row.path);
}
