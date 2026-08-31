import { describe, expect, it, vi } from 'vitest';
import { handleGetChanges, handleGetFileMetadata, handleGetManifest } from './sync-metadata-handlers';

function createStatement(sql: string) {
	const statement = {
		sql,
		args: [] as unknown[],
		bind: vi.fn((...args: unknown[]) => {
			statement.args = args;
			return statement;
		}),
	};
	return statement;
}

describe('sync metadata snapshots', () => {
	it('reads changelog rows and cursor bounds in one D1 batch', async () => {
		const statements: ReturnType<typeof createStatement>[] = [];
		const db = {
			prepare: vi.fn((sql: string) => {
				const statement = createStatement(sql);
				statements.push(statement);
				return statement;
			}),
			batch: vi.fn(async () => [
				{ results: [{ seq: 8, path: 'notes/a.md', action: 'put', hash: 'hash', size: 4, created_at: 'now' }] },
				{ results: [{ lastSeq: 8, minSeq: 3 }] },
			]),
		};

		const response = await handleGetChanges(
			new Request('https://worker.test/sync/changes?since=7'),
			db as never,
		);

		expect(db.batch).toHaveBeenCalledOnce();
		expect(statements).toHaveLength(2);
		expect(statements[0]?.args).toEqual([7]);
		expect(await response.json()).toEqual({
			changes: [{ seq: 8, path: 'notes/a.md', action: 'put', hash: 'hash', size: 4, created_at: 'now' }],
			lastSeq: 8,
			hasMore: false,
		});
	});

	it('reads the manifest and its cursor in one D1 batch', async () => {
		const db = {
			prepare: vi.fn((sql: string) => createStatement(sql)),
			batch: vi.fn(async () => [
				{ results: [{ path: 'notes/a.md', hash: 'hash', size: 4, modified: 'now' }] },
				{ results: [{ lastSeq: 11 }] },
			]),
		};

		const response = await handleGetManifest(
			new Request('https://worker.test/sync/manifest'),
			db as never,
		);

		expect(db.batch).toHaveBeenCalledOnce();
		expect(await response.json()).toEqual({
			version: 1,
			files: {
				'notes/a.md': { hash: 'hash', size: 4, modified: 'now' },
			},
			lastSeq: 11,
			snapshotSeq: 11,
			hasMore: false,
		});
	});

	it('loads metadata only for the requested paths', async () => {
		const statement = {
			args: [] as unknown[],
			bind: vi.fn(function (this: { args: unknown[] }, ...args: unknown[]) {
				this.args = args;
				return this;
			}),
			all: vi.fn(async () => ({
				results: [{ path: 'notes/a.md', hash: 'hash-a', size: 4, modified: 'now' }],
			})),
		};
		const db = { prepare: vi.fn(() => statement) };

		const response = await handleGetFileMetadata(
			new Request('https://worker.test/sync/metadata', {
				method: 'POST',
				body: JSON.stringify({ paths: ['notes/a.md', 'notes/missing.md'] }),
			}),
			db as never,
		);

		expect(statement.args).toEqual(['notes/a.md', 'notes/missing.md']);
		expect(await response.json()).toEqual({
			files: {
				'notes/a.md': { hash: 'hash-a', size: 4, modified: 'now' },
			},
		});
	});
});
