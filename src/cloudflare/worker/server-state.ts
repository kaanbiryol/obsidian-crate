/** Server-wide values that authentication reads with the token, in one row. A
 * missing row or column means the default: plaintext, default features, no reset yet. */
export type ServerStateColumn = 'encryption' | 'features' | 'reset_generation';

/** A scalar subquery for guards that must run in the same statement as a write. */
export const serverStateValue = (column: ServerStateColumn) => `(SELECT ${column} FROM server_state WHERE id = 1)`;

export function saveServerState(db: D1Database, column: ServerStateColumn, value: string | null): D1PreparedStatement {
	return db.prepare(`INSERT INTO server_state(id, ${column}) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET ${column} = excluded.${column}`).bind(value);
}

export async function readServerState(db: D1Database, column: ServerStateColumn): Promise<string | null> {
	return (await db.prepare(`SELECT ${column} AS value FROM server_state WHERE id = 1`).first<{ value: string | null }>())?.value ?? null;
}
