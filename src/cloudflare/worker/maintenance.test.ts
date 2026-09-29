import { describe, expect, it, vi } from 'vitest';
import { runScheduledMaintenance } from './maintenance';

function createStatement(sql: string) {
	const statement = {
		sql,
		args: [] as unknown[],
		bind: vi.fn((...args: unknown[]) => {
			statement.args = args;
			return statement;
		}),
		first: vi.fn(async () => null),
    all: vi.fn(async () => ({
			results: sql.startsWith('SELECT storage_key, file_path FROM object_cleanup_queue')
				? [{ storage_key: 'queued-object' }]
				: [],
		})),
		run: vi.fn(async () => ({})),
	};
	return statement;
}

describe('scheduled Worker maintenance', () => {
	it('records a changelog failure while continuing the remaining cleanup', async () => {
		const statements: ReturnType<typeof createStatement>[] = [];
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				if (sql.startsWith('DELETE FROM changelog')) statement.run.mockRejectedValue(new Error('D1 unavailable'));
				statements.push(statement);
				return statement;
			}),
			batch: vi.fn(async (batch: Array<{ run(): Promise<unknown> }>) => Promise.all(batch.map(statement => statement.run()))),
		};
		const bucket = { delete: vi.fn(async () => {}), get: vi.fn(async () => null), list: vi.fn(async () => ({ objects: [], truncated: false })) };
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await runScheduledMaintenance({ DB: db, BUCKET: bucket } as never);
			expect(bucket.delete).toHaveBeenCalledWith('queued-object');
			expect(statements.some(statement => statement.sql.startsWith('DELETE FROM request_rate_limits') && statement.run.mock.calls.length)).toBe(true);
			expect(statements.find(statement => statement.sql.includes("VALUES ('last_error'"))?.args).toEqual(['prune changelog: D1 unavailable']);
			expect(statements.some(statement => statement.sql === "DELETE FROM maintenance_state WHERE key = 'last_error'")).toBe(false);
		} finally { log.mockRestore(); }
	});
	it('drains queued R2 objects and prunes the changelog', async () => {
		const statements: ReturnType<typeof createStatement>[] = [];
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				statements.push(statement);
				return statement;
			}),
			batch: vi.fn(async (batchStatements: Array<{ run(): Promise<unknown> }>) =>
				Promise.all(batchStatements.map(statement => statement.run()))),
		};
		const bucket = { delete: vi.fn(async () => {}), get: vi.fn(async () => null), list: vi.fn(async () => ({ objects: [], truncated: false })) };

		await runScheduledMaintenance({ DB: db, BUCKET: bucket } as never);

		expect(bucket.delete).toHaveBeenCalledWith('queued-object');
		expect(statements.some((statement) =>
			statement.sql.startsWith('DELETE FROM object_cleanup_queue'))).toBe(true);
		expect(statements.some((statement) =>
			statement.sql.startsWith('DELETE FROM changelog'))).toBe(true);
		expect(statements.find((statement) =>
			statement.sql.startsWith('DELETE FROM changelog'))?.sql).toContain(
			'seq < (SELECT MAX(seq) FROM changelog)',
		);
	});
});
