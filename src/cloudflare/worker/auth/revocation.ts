// Credential revocation shared by the Worker and the local server package. Node loads
// this file directly through type stripping, and the server package ships a transpiled
// copy, so keep it free of imports and use only erasable TypeScript syntax.

/** Revokes the credentials that the SQL `ids` selects, with their push subscriptions and
 * the Shortcut capture credentials they paired. Those record their issuer in `device_id`,
 * which their scope does not otherwise use, so none outlives its issuer. */
export function revokeCredentialStatements(db: D1Database, ids: string, ...bindings: unknown[]): D1PreparedStatement[] {
	return [
		db.prepare(`DELETE FROM push_subscriptions WHERE owner_token_id IN (${ids})`).bind(...bindings),
		db.prepare(`DELETE FROM auth_tokens WHERE scope = 'reading_capture' AND device_id IN (${ids})`).bind(...bindings),
		db.prepare(`DELETE FROM auth_tokens WHERE id IN (${ids})`).bind(...bindings),
	];
}

/** Revokes one credential by ID. Returns whether it existed. */
export async function revokeCredential(db: D1Database, id: string): Promise<boolean> {
	const results = await db.batch<{ meta: { changes: number } }>(revokeCredentialStatements(db, '?', id));
	return results[2]?.meta.changes === 1;
}
