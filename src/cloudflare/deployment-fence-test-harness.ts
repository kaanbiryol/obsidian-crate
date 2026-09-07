/** Minimal mutex storage for tests whose Cloudflare API is otherwise mocked. */
export function createFenceQueryHarness() {
	let value: string | null = null;
	return {
		clear: () => { value = null; },
		query(sql: string, params?: string[]): Array<{ results: Array<Record<string, unknown>> }> | undefined {
			if (sql.startsWith('CREATE TABLE IF NOT EXISTS maintenance_state')) return [{ results: [] }];
			if (sql.startsWith('INSERT INTO maintenance_state (key, value)')) {
				if (value) return [{ results: [] }];
				value = params?.[1] ?? null;
				return [{ results: value ? [{ value }] : [] }];
			}
			if (sql.startsWith('SELECT value FROM maintenance_state WHERE key = ?')) return [{ results: value ? [{ value }] : [] }];
			if (sql.startsWith('DELETE FROM maintenance_state WHERE key = ? AND value = ?')) {
				if (value === params?.[1]) value = null;
				return [{ results: [] }];
			}
			return undefined;
		},
	};
}
