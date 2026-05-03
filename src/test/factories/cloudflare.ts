import { vi, type Mock } from 'vitest';

type StoredObject = {
	body: ArrayBuffer;
	httpMetadata?: { contentType?: string };
	customMetadata?: { hash?: string };
};

type MockR2Object = {
	body: ArrayBuffer;
	size: number;
	httpMetadata?: { contentType?: string };
	customMetadata?: { hash?: string };
	arrayBuffer: () => Promise<ArrayBuffer>;
	text: () => Promise<string>;
};

export type MockR2Bucket = {
	put: Mock<(this: void, key: string, body: ArrayBuffer, options?: StoredObject) => Promise<void>>;
	get: Mock<(this: void, key: string) => Promise<MockR2Object | null>>;
	delete: Mock<(this: void, key: string) => Promise<void>>;
};

type MockD1Statement = {
	_sql: string;
	_args: unknown[];
	bind: Mock<(this: void, ...args: unknown[]) => MockD1Statement>;
	run: Mock<(this: void) => Promise<object>>;
	first: Mock<(this: void) => Promise<{ storage_key: string | null } | null>>;
	all: Mock<(this: void) => Promise<{ results: unknown[] }>>;
};

export type MockD1Database = {
	prepare: Mock<(this: void, sql: string) => MockD1Statement>;
	batch: Mock<(this: void, statements: Array<{ _sql: string; _args: unknown[] }>) => Promise<unknown[]>>;
	exec: Mock<(this: void) => Promise<object>>;
};

export function createMockR2Bucket(initialEntries: Record<string, string> = {}) {
	const store = new Map<string, StoredObject>();
	for (const [key, value] of Object.entries(initialEntries)) {
		store.set(key, {
			body: new TextEncoder().encode(value).buffer,
		});
	}

	const bucket: MockR2Bucket = {
		put: vi.fn(async (key: string, body: ArrayBuffer, options?: StoredObject) => {
			store.set(key, {
				body,
				httpMetadata: options?.httpMetadata,
				customMetadata: options?.customMetadata,
			});
		}),
		get: vi.fn(async (key: string) => {
			const entry = store.get(key);
			if (!entry) {
				return null;
			}

			return {
				body: entry.body,
				size: entry.body.byteLength,
				httpMetadata: entry.httpMetadata,
				customMetadata: entry.customMetadata,
				arrayBuffer: async () => entry.body,
				text: async () => new TextDecoder().decode(entry.body),
			};
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
	};

	return { store, bucket };
}

export function createMockD1Database(options?: { failBatch?: boolean; files?: Record<string, string | null> }) {
	const files = new Map<string, string | null>(Object.entries(options?.files ?? {}));

	function getBoundString(args: unknown[], index: number): string {
		const value = args[index];
		return typeof value === 'string' ? value : '';
	}

	const db: MockD1Database = {
		prepare: vi.fn((sql: string) => {
			const statement: MockD1Statement = {
				_sql: sql,
				_args: [] as unknown[],
				bind: vi.fn((...args: unknown[]) => {
					statement._args = args;
					return statement;
				}),
				run: vi.fn(async () => {
					if (sql.startsWith('CREATE TABLE') || sql.startsWith('ALTER TABLE')) {
						return {};
					}
					return {};
				}),
				first: vi.fn(async () => {
					if (sql.includes('SELECT storage_key FROM files WHERE path = ?')) {
						const path = getBoundString(statement._args, 0);
						if (!files.has(path)) {
							return null;
						}

						return { storage_key: files.get(path) };
					}

					return null;
				}),
				all: vi.fn(async () => ({ results: [] })),
			};
			return statement;
		}),
		batch: vi.fn(async (statements: Array<{ _sql: string; _args: unknown[] }>) => {
			if (options?.failBatch) {
				throw new Error('D1 unavailable');
			}

			for (const statement of statements) {
				if (statement._sql.includes("INSERT OR REPLACE INTO files")) {
					files.set(getBoundString(statement._args, 0), typeof statement._args[3] === 'string' ? statement._args[3] : null);
				}

				if (statement._sql.includes('DELETE FROM files WHERE path = ?')) {
					files.delete(getBoundString(statement._args, 0));
				}
			}

			return [];
		}),
		exec: vi.fn(async () => ({})),
	};

	return { db, files };
}
