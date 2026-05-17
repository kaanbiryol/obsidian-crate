import { vi, type Mock } from 'vitest';

interface CompatibleR2HttpMetadata {
	contentType?: string;
}

interface CompatibleR2PutOptions {
	httpMetadata?: CompatibleR2HttpMetadata;
	customMetadata?: Record<string, string>;
}

interface CompatibleR2ObjectBody {
	body: ReadableStream | null;
	size: number;
	httpMetadata?: CompatibleR2HttpMetadata;
	customMetadata?: Record<string, string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

interface CompatibleD1PreparedStatement {
	bind(...args: unknown[]): CompatibleD1PreparedStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<unknown>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

interface CompatibleD1Database {
	prepare(query: string): CompatibleD1PreparedStatement;
	batch<T = unknown>(statements: CompatibleD1PreparedStatement[]): Promise<T[]>;
	exec(query: string): Promise<unknown>;
}

type StoredObject = {
	body: ArrayBuffer;
	httpMetadata?: CompatibleR2HttpMetadata;
	customMetadata?: Record<string, string>;
};

export type MockR2Bucket = {
	put: Mock<(this: void, key: string, body: BodyInit | null, options?: CompatibleR2PutOptions) => Promise<unknown>>;
	get: Mock<(this: void, key: string) => Promise<CompatibleR2ObjectBody | null>>;
	delete: Mock<(this: void, keys: string | string[]) => Promise<void>>;
};

type MockD1Statement = CompatibleD1PreparedStatement & {
	_sql: string;
	_args: unknown[];
	bind: Mock<(this: void, ...args: unknown[]) => MockD1Statement>;
	run: Mock<(this: void) => Promise<object>>;
	first: (<T = Record<string, unknown>>(this: void) => Promise<T | null>) & Mock;
	all: (<T = Record<string, unknown>>(this: void) => Promise<{ results: T[] }>) & Mock;
};

export type MockD1Database = CompatibleD1Database & {
	prepare: Mock<(this: void, sql: string) => MockD1Statement>;
	batch: (<T = unknown>(this: void, statements: CompatibleD1PreparedStatement[]) => Promise<T[]>) & Mock;
	exec: Mock<(this: void) => Promise<object>>;
};

async function bodyToArrayBuffer(body: BodyInit | null): Promise<ArrayBuffer> {
	if (body === null) {
		return new ArrayBuffer(0);
	}
	if (body instanceof ArrayBuffer) {
		return body;
	}
	return new Response(body).arrayBuffer();
}

export function createMockR2Bucket(initialEntries: Record<string, string> = {}) {
	const store = new Map<string, StoredObject>();
	for (const [key, value] of Object.entries(initialEntries)) {
		store.set(key, {
			body: new TextEncoder().encode(value).buffer,
		});
	}

	const bucket: MockR2Bucket = {
		put: vi.fn(async (key: string, body: BodyInit | null, options?: CompatibleR2PutOptions) => {
			store.set(key, {
				body: await bodyToArrayBuffer(body),
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
				body: new Response(entry.body).body,
				size: entry.body.byteLength,
				httpMetadata: entry.httpMetadata,
				customMetadata: entry.customMetadata,
				arrayBuffer: async () => entry.body,
				text: async () => new TextDecoder().decode(entry.body),
			};
		}),
		delete: vi.fn(async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				store.delete(key);
			}
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
				first: vi.fn(async <T = Record<string, unknown>>() => {
					if (sql.includes('SELECT storage_key FROM files WHERE path = ?')) {
						const path = getBoundString(statement._args, 0);
						if (!files.has(path)) {
							return null;
						}

						return { storage_key: files.get(path) } as T;
					}

					return null;
				}) as MockD1Statement['first'],
				all: vi.fn(async <T = Record<string, unknown>>() => ({ results: [] as T[] })) as MockD1Statement['all'],
			};
			return statement;
		}),
		batch: vi.fn(async <T = unknown>(statements: CompatibleD1PreparedStatement[]) => {
			if (options?.failBatch) {
				throw new Error('D1 unavailable');
			}

			for (const statement of statements as MockD1Statement[]) {
				if (statement._sql.includes("INSERT OR REPLACE INTO files")) {
					files.set(getBoundString(statement._args, 0), typeof statement._args[3] === 'string' ? statement._args[3] : null);
				}

				if (statement._sql.includes('DELETE FROM files WHERE path = ?')) {
					files.delete(getBoundString(statement._args, 0));
				}
			}

			return [] as T[];
		}) as MockD1Database['batch'],
		exec: vi.fn(async () => ({})),
	};

	return { db, files };
}
