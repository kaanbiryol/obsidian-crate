import { describe, expect, it, vi } from 'vitest';
import { initDb } from './db';

function createDb() {
	const run = vi.fn(async () => ({}));
	return {
		db: {
			prepare: vi.fn((sql: string) => ({
				run,
				all: vi.fn(async () => ({
					results: sql.includes('PRAGMA table_info(files)')
						? [{ name: 'path' }, { name: 'storage_key' }]
						: [],
				})),
			})),
		},
		run,
	};
}

describe('initDb', () => {
	it('initializes each database instance independently', async () => {
		const first = createDb();
		const second = createDb();

	await initDb(first.db as never);
	await initDb(first.db as never);
	await initDb(second.db as never);

		expect(first.db.prepare).toHaveBeenCalledTimes(8);
		expect(second.db.prepare).toHaveBeenCalledTimes(8);
	});
});
