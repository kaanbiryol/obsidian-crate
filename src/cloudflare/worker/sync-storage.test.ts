import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteBucketObjectsOrQueue, drainObjectCleanupQueue } from './sync-storage';

function createStatement(sql: string) {
	const statement = {
		sql,
		args: [] as unknown[],
		bind: vi.fn((...args: unknown[]) => {
			statement.args = args;
			return statement;
		}),
		all: vi.fn(async () => ({ results: [] as Array<{ storage_key: string }> })),
		run: vi.fn(async () => ({})),
	};
	return statement;
}

describe('R2 object cleanup queue', () => {
	afterEach(() => vi.restoreAllMocks());

	it('queues an object key when immediate R2 deletion fails', async () => {
		const prepared: ReturnType<typeof createStatement>[] = [];
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				prepared.push(statement);
				return statement;
			}),
			batch: vi.fn(async () => []),
		};
		const bucket = {
			delete: vi.fn(async () => { throw new Error('R2 unavailable'); }),
		};

		await deleteBucketObjectsOrQueue(bucket as never, db as never, ['object-key']);

		expect(db.batch).not.toHaveBeenCalled();
		expect(prepared[0]?.sql).toContain('INSERT OR IGNORE INTO object_cleanup_queue');
		expect(prepared[0]?.args).toEqual(['object-key']);
		expect(prepared[0]?.run).toHaveBeenCalledOnce();
	});

	it('removes successfully deleted keys from the retry queue', async () => {
		const prepared: ReturnType<typeof createStatement>[] = [];
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				if (sql.startsWith('SELECT storage_key')) {
					statement.all.mockResolvedValue({ results: [{ storage_key: 'queued-key' }] });
				}
				prepared.push(statement);
				return statement;
			}),
			batch: vi.fn(async () => []),
		};
		const bucket = { delete: vi.fn(async () => {}) };

		await drainObjectCleanupQueue(bucket as never, db as never);

		expect(bucket.delete).toHaveBeenCalledWith('queued-key');
		expect(prepared.at(-1)?.sql).toContain('DELETE FROM object_cleanup_queue');
		expect(prepared.at(-1)?.args).toEqual(['queued-key']);
		expect(prepared.at(-1)?.run).toHaveBeenCalledOnce();
		expect(db.batch).not.toHaveBeenCalled();
	});
});
