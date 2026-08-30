import { vi, type Mock } from 'vitest';

interface CompatibleR2HttpMetadata {
	contentType?: string;
}

interface CompatibleR2PutOptions {
	httpMetadata?: CompatibleR2HttpMetadata;
	customMetadata?: Record<string, string>;
	onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
}

interface CompatibleR2ObjectBody {
	key: string;
	etag: string;
	uploaded: Date;
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
	etag: string;
	uploaded: Date;
	httpMetadata?: CompatibleR2HttpMetadata;
	customMetadata?: Record<string, string>;
};

type MockR2Bucket = {
	put: Mock<(this: void, key: string, body: BodyInit | null, options?: CompatibleR2PutOptions) => Promise<CompatibleR2ObjectBody | null>>;
	get: Mock<(this: void, key: string) => Promise<CompatibleR2ObjectBody | null>>;
	head: Mock<(this: void, key: string) => Promise<CompatibleR2ObjectBody | null>>;
	delete: Mock<(this: void, keys: string | string[]) => Promise<void>>;
	list: Mock<(this: void, options?: { prefix?: string; limit?: number; cursor?: string }) => Promise<{ objects: CompatibleR2ObjectBody[]; truncated: boolean; cursor?: string }>>;
};

type MockD1Statement = CompatibleD1PreparedStatement & {
	_sql: string;
	_args: unknown[];
	bind: Mock<(this: void, ...args: unknown[]) => MockD1Statement>;
	run: Mock<(this: void) => Promise<object>>;
	first: (<T = Record<string, unknown>>(this: void) => Promise<T | null>) & Mock;
	all: (<T = Record<string, unknown>>(this: void) => Promise<{ results: T[] }>) & Mock;
};

type MockD1Database = CompatibleD1Database & {
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
			etag: `initial-${key}`,
			uploaded: new Date(),
		});
	}
	let etagSequence = 0;

	function asObject(key: string, entry: StoredObject): CompatibleR2ObjectBody {
		return {
			key,
			etag: entry.etag,
			uploaded: entry.uploaded,
			body: new Response(entry.body).body,
			size: entry.body.byteLength,
			httpMetadata: entry.httpMetadata,
			customMetadata: entry.customMetadata,
			arrayBuffer: async () => entry.body,
			text: async () => new TextDecoder().decode(entry.body),
		};
	}

	const bucket: MockR2Bucket = {
		put: vi.fn(async (key: string, body: BodyInit | null, options?: CompatibleR2PutOptions) => {
			const current = store.get(key);
			if (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
			if (options?.onlyIf?.etagDoesNotMatch === '*' && current) return null;
			const entry: StoredObject = {
				body: await bodyToArrayBuffer(body),
				etag: `etag-${++etagSequence}`,
				uploaded: new Date(),
				httpMetadata: options?.httpMetadata,
				customMetadata: options?.customMetadata,
			};
			store.set(key, {
				...entry,
			});
			return asObject(key, entry);
		}),
		get: vi.fn(async (key: string) => {
			const entry = store.get(key);
			return entry ? asObject(key, entry) : null;
		}),
		head: vi.fn(async (key: string) => {
			const entry = store.get(key);
			return entry ? asObject(key, entry) : null;
		}),
		delete: vi.fn(async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				store.delete(key);
			}
		}),
		list: vi.fn(async options => {
			const keys = [...store.keys()]
				.filter(key => !options?.prefix || key.startsWith(options.prefix))
				.sort();
			const start = options?.cursor ? Math.max(0, keys.indexOf(options.cursor) + 1) : 0;
			const limit = options?.limit ?? 1000;
			const selected = keys.slice(start, start + limit);
			const truncated = start + selected.length < keys.length;
			return {
				objects: selected.map(key => asObject(key, store.get(key)!)),
				truncated,
				...(truncated && selected.length > 0 ? { cursor: selected.at(-1) } : {}),
			};
		}),
	};

	return { store, bucket };
}

interface MockFileRecord {
	hash: string;
	size: number;
	storageKey: string;
}

type MockFileInput = string | MockFileRecord;

export function createMockD1Database(options?: { failBatch?: boolean; files?: Record<string, MockFileInput> }) {
	const files = new Map<string, MockFileRecord>(
		Object.entries(options?.files ?? {}).map(([path, value]) => [path,
			typeof value === 'object' && value !== null
				? value
				: { hash: '', size: 0, storageKey: value },
		]),
	);

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
					if (sql.includes('FROM files WHERE path = ?')) {
						const path = getBoundString(statement._args, 0);
						const file = files.get(path);
						if (!file) {
							return null;
						}

						return {
							hash: file.hash,
							size: file.size,
							storage_key: file.storageKey,
						} as T;
					}

					return null;
				}) as MockD1Statement['first'],
				all: vi.fn(async <T = Record<string, unknown>>() => {
					if (sql.includes('FROM files WHERE path IN')) {
						const results = statement._args.flatMap((value) => {
							if (typeof value !== 'string') return [];
							const file = files.get(value);
							return file ? [{
								path: value,
								hash: file.hash,
								size: file.size,
								storage_key: file.storageKey,
							}] : [];
						});
						return { results: results as T[] };
					}
					return { results: [] as T[] };
				}) as MockD1Statement['all'],
			};
			return statement;
		}),
		batch: vi.fn(async <T = unknown>(statements: CompatibleD1PreparedStatement[]) => {
			if (options?.failBatch) {
				throw new Error('D1 unavailable');
			}

			const results: Array<{ meta: { changes: number } }> = [];
			for (const statement of statements as MockD1Statement[]) {
				let changes = 0;
				if (statement._sql.includes('INSERT INTO files (path, portable_path, hash, size, modified, storage_key)')) {
					const path = getBoundString(statement._args, 0);
					if (statement._sql.includes('DO NOTHING') && files.has(path)) {
						changes = 0;
					} else {
						files.set(path, {
							hash: getBoundString(statement._args, 2),
							size: Number(statement._args[3]),
							storageKey: getBoundString(statement._args, 4),
						});
						changes = 1;
					}
				} else if (statement._sql.startsWith('UPDATE files')) {
					const path = getBoundString(statement._args, 4);
					const expectedHash = getBoundString(statement._args, 5);
					const current = files.get(path);
					if (current?.hash === expectedHash) {
						files.set(path, {
							hash: getBoundString(statement._args, 1),
							size: Number(statement._args[2]),
							storageKey: getBoundString(statement._args, 3),
						});
						changes = 1;
					}
				} else if (statement._sql.includes('DELETE FROM files WHERE')) {
					const path = getBoundString(statement._args, 0);
					const current = files.get(path);
					const expectedHash = statement._args[1];
					if (current && (expectedHash === undefined || current.hash === expectedHash)) {
						files.delete(path);
						changes = 1;
					}
				} else if (statement._sql.includes('INSERT INTO changelog')) {
					changes = 1;
				}
				results.push({ meta: { changes } });
			}

			return results as T[];
		}) as MockD1Database['batch'],
		exec: vi.fn(async () => ({})),
	};

	return { db, files };
}
