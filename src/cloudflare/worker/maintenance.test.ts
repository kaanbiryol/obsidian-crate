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
		all: vi.fn(async () => ({
			results: sql.startsWith('SELECT storage_key')
				? [{ storage_key: 'queued-object' }]
				: [],
		})),
		run: vi.fn(async () => ({})),
	};
	return statement;
}

describe('scheduled Worker maintenance', () => {
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
		const bucket = { delete: vi.fn(async () => {}) };

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
