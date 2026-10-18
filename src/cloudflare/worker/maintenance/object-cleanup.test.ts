import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteBucketObjectsOrQueue, drainObjectCleanupQueue } from './object-cleanup';

function createStatement(sql: string) {
	const statement = {
		sql,
		args: [] as unknown[],
		bind: vi.fn((...args: unknown[]) => {
			statement.args = args;
			return statement;
		}),
		all: vi.fn(async () => ({ results: [] as Array<{ storage_key: string; file_path: string }> })),
		run: vi.fn(async () => ({})),
	};
	return statement;
}

describe('R2 object cleanup queue', () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(['queueing', 'reference lookup', 'queue settlement'])('keeps post-commit cleanup nonfatal when %s fails', async failure => {
		const error = new Error('D1 unavailable');
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				if (failure === 'queueing' && sql.startsWith('INSERT OR IGNORE INTO object_cleanup_queue')
					|| failure === 'queue settlement' && sql.startsWith('DELETE FROM object_cleanup_queue')) statement.run.mockRejectedValue(error);
				if (failure === 'reference lookup' && sql.startsWith('WITH input AS')) statement.all.mockRejectedValue(error);
				return statement;
			}),
		};
		const bucket = { delete: vi.fn(async () => {}) };

		await expect(deleteBucketObjectsOrQueue(bucket as never, db as never, [{ storageKey: 'object-key', path: 'note.md' }])).resolves.toBeUndefined();
		if (failure === 'reference lookup') expect(bucket.delete).not.toHaveBeenCalled();
		else expect(bucket.delete).toHaveBeenCalledWith('object-key');
	});

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

		await deleteBucketObjectsOrQueue(bucket as never, db as never, [{ storageKey: 'object-key', path: 'note.md' }]);

		expect(db.batch).not.toHaveBeenCalled();
		expect(prepared[0]?.sql).toContain('INSERT OR IGNORE INTO object_cleanup_queue');
		expect(prepared[0]?.args).toEqual(['[{"storageKey":"object-key","path":"note.md"}]']);
		expect(prepared[0]?.run).toHaveBeenCalledOnce();
	});

	it('removes successfully deleted keys from the retry queue', async () => {
		const prepared: ReturnType<typeof createStatement>[] = [];
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				if (sql.startsWith('SELECT storage_key, file_path FROM object_cleanup_queue')) {
					statement.all.mockResolvedValue({ results: [{ storage_key: 'queued-key', file_path: 'queued.md' }] });
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
		expect(prepared.at(-1)?.args).toEqual(['["queued-key"]']);
		expect(prepared.at(-1)?.run).toHaveBeenCalledOnce();
		expect(db.batch).not.toHaveBeenCalled();
	});
});
