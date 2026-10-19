import { describe, expect, it, vi } from 'vitest';
import { runScheduledMaintenance } from './run';

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
				? [{ storage_key: 'queued-object', file_path: 'queued.md' }]
				: [],
		})),
		run: vi.fn(async () => ({})),
	};
	return statement;
}

describe('scheduled Worker maintenance', () => {
	it.each(['queue read', 'reference lookup', 'R2 deletion', 'staging cleanup', 'queue settlement'])('records %s failure without skipping other maintenance', async failure => {
		const statements: ReturnType<typeof createStatement>[] = [];
		const error = new Error('Cleanup unavailable');
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				if (failure === 'queue read' && sql.startsWith('SELECT storage_key, file_path FROM object_cleanup_queue')
					|| failure === 'reference lookup' && sql.startsWith('WITH input AS')) statement.all.mockRejectedValue(error);
				if (failure === 'staging cleanup' && sql.startsWith('DELETE FROM staged_uploads WHERE storage_key IN (SELECT value')
					|| failure === 'queue settlement' && sql.startsWith('DELETE FROM object_cleanup_queue')) statement.run.mockRejectedValue(error);
				statements.push(statement);
				return statement;
			}),
			batch: vi.fn(async (batch: Array<{ run(): Promise<unknown> }>) => Promise.all(batch.map(statement => statement.run()))),
		};
		const bucket = {
			delete: vi.fn(async () => { if (failure === 'R2 deletion') throw error; }),
			get: vi.fn(async () => null),
			list: vi.fn(async () => ({ objects: [], truncated: false })),
		};
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(runScheduledMaintenance({ DB: db, BUCKET: bucket } as never)).resolves.toEqual({ removedObjects: 0, backlog: false });
			expect(statements.find(statement => statement.sql.includes("VALUES ('last_error'"))?.args)
				.toEqual(['drain object cleanup: Cleanup unavailable']);
			expect(statements.some(statement => statement.sql === "DELETE FROM maintenance_state WHERE key = 'last_error'"))
				.toBe(false);
			expect(statements.some(statement => statement.sql.startsWith('DELETE FROM request_rate_limits') && statement.run.mock.calls.length)).toBe(true);
			if (failure === 'queue read' || failure === 'reference lookup') expect(bucket.delete).not.toHaveBeenCalled();
			else expect(bucket.delete).toHaveBeenCalledWith('queued-object');
			if (failure !== 'queue settlement') expect(statements.some(statement => statement.sql.startsWith('DELETE FROM object_cleanup_queue'))).toBe(false);
		} finally { log.mockRestore(); }
	});

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

it('checks unused encryption descriptors only on the first pass of an episode', async () => {
	const statements: ReturnType<typeof createStatement>[] = [];
	const db = {
		prepare: vi.fn((sql: string) => { const statement = createStatement(sql); statements.push(statement); return statement; }),
		batch: vi.fn(async (batch: Array<{ run(): Promise<unknown> }>) => Promise.all(batch.map(statement => statement.run()))),
	};
	const bucket = { delete: vi.fn(async () => {}), get: vi.fn(async () => null), list: vi.fn(async () => ({ objects: [], truncated: false })) };
	const descriptorChecks = () => statements.filter(statement => statement.sql.includes('consumed_revision FROM file_deletion_receipts')).length;

	await runScheduledMaintenance({ DB: db, BUCKET: bucket } as never, { firstPass: true });
	expect(descriptorChecks()).toBe(1);
	// Before: every backlog pass (up to 200 per episode) rescanned the referencing tables.
	await runScheduledMaintenance({ DB: db, BUCKET: bucket } as never, { firstPass: false });
	expect(descriptorChecks()).toBe(1);
	expect(statements.filter(statement => statement.sql.startsWith('DELETE FROM request_rate_limits')).length).toBe(2);
});
