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
	it('does not execute runtime schema DDL', async () => {
		const database = createDb();

		await initDb(database.db as never);

		expect(database.db.prepare).not.toHaveBeenCalled();
		expect(database.run).not.toHaveBeenCalled();
	});
});
