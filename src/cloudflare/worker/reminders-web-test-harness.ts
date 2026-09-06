import { scanReminderMarkdownFile } from './reminders-web/scan';
import { reminderRevision } from '@/reminders/core/reminderRevision';
import { vi } from 'vitest';
import { sha256HexBytes } from './auth';

type StoredObject = {
	body: ArrayBuffer;
	httpMetadata?: { contentType?: string };
	customMetadata?: { hash?: string };
};

type ReminderCacheValue = {
	fileHash: string;
	parserVersion: number;
	remindersJson: string;
};

function createBucket(
	initialEntries: Record<string, string> = {},
	config?: {
		failPutWhen?: (key: string, content: string) => boolean;
	},
) {
	const store = new Map<string, StoredObject>();
	for (const [key, value] of Object.entries(initialEntries)) {
		store.set(key, {
			body: new TextEncoder().encode(value).buffer,
		});
	}

	return {
		store,
		bucket: {
			put: vi.fn(async (key: string, body: ArrayBuffer | Uint8Array, options?: StoredObject) => {
				const normalizedBody = body instanceof Uint8Array ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body;
				const content = new TextDecoder().decode(normalizedBody);
				if (config?.failPutWhen?.(key, content)) {
					throw new Error('forced put failure');
				}
				store.set(key, {
					body: normalizedBody,
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
			delete: vi.fn(async (key: string | string[]) => {
				for (const entry of Array.isArray(key) ? key : [key]) store.delete(entry);
			}),
		},
	};
}
function createDb(options?: {
	files?: Record<string, string>;
	fileSizes?: Record<string, number>;
	fileHashes?: Record<string, string>;
	committedPaths?: string[];
	atomicSourceConflictPath?: string;
}) {
	const files = new Map<string, string>(Object.entries(options?.files ?? {}));
	const hashes = new Map<string, string>(Object.entries(options?.fileHashes ?? {}));
	const sizes = new Map<string, number>(Object.entries(options?.fileSizes ?? {}));
	const scheduled = new Map<string, { content: string; project: string | null; dueDatetime: string }>();
	const notificationJobs = new Map<string, {
		reminder_id: string;
		job_token: string;
		operation: 'schedule' | 'cancel';
		payload_json: string | null;
		attempts: number;
	}>();
	const reminderCache = new Map<string, ReminderCacheValue>();
	const reminderCacheKey = (folderPath: string, filePath: string) => `${folderPath}\0${filePath}`;

	function getBoundString(args: unknown[], index: number): string {
		const value = args[index];
		return typeof value === 'string' ? value : '';
	}

	const db = {
		prepare: vi.fn((sql: string) => {
			const statement = {
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

					if (sql.includes('INSERT OR REPLACE INTO scheduled_reminders')) {
						scheduled.set(getBoundString(statement._args, 0), {
							content: getBoundString(statement._args, 1),
							project: statement._args[2] === null ? null : getBoundString(statement._args, 2),
							dueDatetime: getBoundString(statement._args, 3),
						});
					}

					if (sql.includes('DELETE FROM scheduled_reminders WHERE reminder_id = ?')) {
						scheduled.delete(getBoundString(statement._args, 0));
					}

					if (sql.includes('INSERT INTO notification_jobs')) {
						const reminderId = getBoundString(statement._args, 0);
						notificationJobs.set(reminderId, {
							reminder_id: reminderId,
							job_token: getBoundString(statement._args, 1),
							operation: getBoundString(statement._args, 2) as 'schedule' | 'cancel',
							payload_json: statement._args[3] === null ? null : getBoundString(statement._args, 3),
							attempts: 0,
						});
					}

					if (sql.includes('DELETE FROM notification_jobs WHERE reminder_id = ? AND job_token = ?')) {
						const reminderId = getBoundString(statement._args, 0);
						if (notificationJobs.get(reminderId)?.job_token === getBoundString(statement._args, 1)) {
							notificationJobs.delete(reminderId);
						}
					}

					if (sql.startsWith('DELETE FROM reminder_file_cache')) {
						const folderPath = getBoundString(statement._args, 0);
						for (const key of reminderCache.keys()) {
							const [cachedFolderPath, cachedFilePath] = key.split('\0');
							if (cachedFolderPath === folderPath && cachedFilePath && !files.has(cachedFilePath)) {
								reminderCache.delete(key);
							}
						}
					}

					return {};
				}),
				first: vi.fn(async () => {
					if (sql.includes('FROM notification_jobs WHERE reminder_id = ?')) {
						return notificationJobs.get(getBoundString(statement._args, 0)) ?? null;
					}
					if (sql.includes('FROM files WHERE path = ?')) {
						const path = getBoundString(statement._args, 0);
						if (!files.has(path)) {
							return null;
						}
						return {
							hash: hashes.get(path) ?? '',
							size: sizes.get(path) ?? 0,
							storage_key: files.get(path),
						};
					}

					return null;
				}),
				all: vi.fn(async () => {
					if (sql.includes('PRAGMA table_info(files)')) {
						return { results: [{ name: 'path' }, { name: 'storage_key' }] };
					}
					if (sql.includes('PRAGMA table_info(auth_tokens)')) {
						return { results: [{ name: 'id' }, { name: 'token_hash' }, { name: 'device_id' }, { name: 'device_name' }, { name: 'platform' }, { name: 'last_seen_at' }] };
					}
					if (sql.includes('FROM reminder_file_cache')) {
						const folderPath = getBoundString(statement._args, 0);
						return {
							results: Array.from(reminderCache.entries())
								.filter(([key]) => key.startsWith(`${folderPath}\0`))
								.map(([key, value]) => ({
									file_path: key.slice(folderPath.length + 1),
									file_hash: value.fileHash,
									parser_version: value.parserVersion,
									reminders_json: value.remindersJson,
								})),
						};
					}
					if (sql.includes('path >= ?') && sql.includes("lower(path) LIKE '%.md'")) {
						const prefix = getBoundString(statement._args, 0);
						return {
							results: Array.from(files.keys())
								.filter((path) => path.startsWith(prefix) && path.toLowerCase().endsWith('.md'))
								.sort()
								.map((path) => ({
									path,
									hash: hashes.get(path) ?? '',
									size: sizes.get(path) ?? 0,
									storage_key: files.get(path),
								})),
						};
					}
					return { results: [] };
				}),
			};
			return statement;
		}),
		batch: vi.fn(async (statements: Array<{ _sql: string; _args: unknown[] }>) => {
			if (options?.atomicSourceConflictPath && statements.some(statement => statement._sql.includes('atomic-'))) {
				hashes.set(options.atomicSourceConflictPath, 'f'.repeat(64));
			}
			const results: Array<{ meta: { changes: number } }> = [];
			for (const statement of statements) {
				let changes = 0;
				if (statement._sql.includes('atomic-destination-insert')) {
					const destinationPath = getBoundString(statement._args, 0);
					const sourcePath = getBoundString(statement._args, 6);
					const sourceExpectedHash = getBoundString(statement._args, 7);
					if (!files.has(destinationPath) && hashes.get(sourcePath) === sourceExpectedHash) {
						files.set(destinationPath, getBoundString(statement._args, 4));
						hashes.set(destinationPath, getBoundString(statement._args, 2));
						sizes.set(destinationPath, Number(statement._args[3]));
						options?.committedPaths?.push(destinationPath);
						changes = 1;
					}
				} else if (statement._sql.includes('atomic-destination-update')) {
					const destinationPath = getBoundString(statement._args, 4);
					const sourcePath = getBoundString(statement._args, 6);
					if (
						hashes.get(destinationPath) === getBoundString(statement._args, 5)
						&& hashes.get(sourcePath) === getBoundString(statement._args, 7)
					) {
						files.set(destinationPath, getBoundString(statement._args, 3));
						hashes.set(destinationPath, getBoundString(statement._args, 1));
						sizes.set(destinationPath, Number(statement._args[2]));
						options?.committedPaths?.push(destinationPath);
						changes = 1;
					}
				} else if (statement._sql.includes('atomic-source-update')) {
					const sourcePath = getBoundString(statement._args, 4);
					const destinationPath = getBoundString(statement._args, 6);
					if (
						hashes.get(sourcePath) === getBoundString(statement._args, 5)
						&& files.get(destinationPath) === getBoundString(statement._args, 7)
					) {
						files.set(sourcePath, getBoundString(statement._args, 3));
						hashes.set(sourcePath, getBoundString(statement._args, 1));
						sizes.set(sourcePath, Number(statement._args[2]));
						options?.committedPaths?.push(sourcePath);
						changes = 1;
					}
				} else if (statement._sql.includes('INSERT INTO reminder_file_cache')) {
					const folderPath = getBoundString(statement._args, 0);
					const filePath = getBoundString(statement._args, 1);
					const fileHash = getBoundString(statement._args, 2);
					if (files.has(filePath) && hashes.get(filePath) === fileHash) {
						reminderCache.set(reminderCacheKey(folderPath, filePath), {
							fileHash,
							parserVersion: Number(statement._args[3]),
							remindersJson: getBoundString(statement._args, 4),
						});
						changes = 1;
					}
				} else if (statement._sql.includes('INSERT INTO files (path, portable_path, hash, size, modified, storage_key)')) {
					const path = getBoundString(statement._args, 0);
					if (!statement._sql.includes('DO NOTHING') || !files.has(path)) {
						files.set(path, getBoundString(statement._args, 4));
						hashes.set(path, getBoundString(statement._args, 2));
						sizes.set(path, Number(statement._args[3]));
						options?.committedPaths?.push(path);
						changes = 1;
					}
				} else if (statement._sql.startsWith('UPDATE files')) {
					const path = getBoundString(statement._args, 4);
					if (hashes.get(path) === getBoundString(statement._args, 5)) {
						files.set(path, getBoundString(statement._args, 3));
						hashes.set(path, getBoundString(statement._args, 1));
						sizes.set(path, Number(statement._args[2]));
						options?.committedPaths?.push(path);
						changes = 1;
					}
				}
				if (statement._sql.includes('DELETE FROM files WHERE')) {
					const path = getBoundString(statement._args, 0);
					const expectedHash = statement._args[1];
					if (files.has(path) && (expectedHash === undefined || hashes.get(path) === expectedHash)) {
						files.delete(path);
						hashes.delete(path);
						sizes.delete(path);
						changes = 1;
					}
				} else if (statement._sql.includes('INSERT INTO changelog')) {
					changes = 1;
				}
				results.push({ meta: { changes } });
			}
			return results;
		}),
		exec: vi.fn(async () => ({})),
	};

	return { db, files, hashes, reminderCache, scheduled, sizes };
}

export async function createEnv(input: {
	bucketEntries: Record<string, string>;
	files: Record<string, string | null>;
	failPutWhen?: (key: string, content: string) => boolean;
	atomicSourceConflictPath?: string;
}) {
	const committedPaths: string[] = [];
	const { bucket, store } = createBucket(input.bucketEntries, { failPutWhen: input.failPutWhen });
	const resolvedFiles = Object.fromEntries(Object.entries(input.files).map(([path, storageKey]) => [
		path,
		storageKey ?? `files/${path}`,
	]));
	const fileSizes = Object.fromEntries(Object.entries(resolvedFiles).map(([path, objectKey]) => {
		return [path, store.get(objectKey)?.body.byteLength ?? 0];
	}));
	const hashEntries = await Promise.all(Object.entries(resolvedFiles).map(async ([path, objectKey]) => {
		const body = store.get(objectKey)?.body;
		return [path, body ? await sha256HexBytes(body) : ''] as const;
	}));
	const fileHashes: Record<string, string> = Object.fromEntries(hashEntries);
	const { db, files, hashes, reminderCache, scheduled, sizes } = createDb({
		files: resolvedFiles,
		fileSizes,
		fileHashes,
		committedPaths,
		atomicSourceConflictPath: input.atomicSourceConflictPath,
	});

	return {
		env: {
			BUCKET: bucket,
			DB: db,
			REMINDER_ALARMS: {
				idFromName: vi.fn((name: string) => name),
				get: vi.fn((name: string) => ({
					fetch: vi.fn(async (url: string, init?: RequestInit) => {
						if (url.endsWith('/schedule') && typeof init?.body === 'string') {
							const body = JSON.parse(init.body) as { reminderId: string; content: string; project?: string; dueDatetime: string };
							scheduled.set(name, {
								content: body.content,
								project: body.project ?? null,
								dueDatetime: body.dueDatetime,
							});
						}
						if (new URL(url).pathname.endsWith('/cancel')) {
							scheduled.delete(name);
						}
						return new Response(null, { status: 200 });
					}),
				})),
			},
		},
		store,
		files,
		scheduled,
		committedPaths,
		async mutationBody(body: Record<string, unknown>) {
			const path = typeof body.filePath === 'string' ? body.filePath : `Reminders/${typeof body.project === 'string' ? body.project : 'Inbox'}.md`;
			const stored = store.get(files.get(path) ?? '');
			const reminders = scanReminderMarkdownFile(path, stored ? new TextDecoder().decode(stored.body) : '', 'Reminders');
			const reminder = reminders.find(item => item.id === body.id);
			return JSON.stringify({ operationId: crypto.randomUUID(),
				expectedRevision: reminder ? await reminderRevision(reminder) : undefined,
				expectedOrder: reminders.map(item => item.id), ...body });
		},
		getCurrentHash(path: string) {
			return hashes.get(path) ?? null;
		},
		async replaceCurrentFile(path: string, content: string) {
			const storageKey = files.get(path) ?? `files/${path}`;
			const body = new TextEncoder().encode(content).buffer;
			store.set(storageKey, { body });
			files.set(path, storageKey);
			hashes.set(path, await sha256HexBytes(body));
			sizes.set(path, body.byteLength);
		},
		setCachedParserVersion(folderPath: string, filePath: string, parserVersion: number) {
			const key = `${folderPath}\0${filePath}`;
			const cached = reminderCache.get(key);
			if (cached) cached.parserVersion = parserVersion;
		},
		corruptCachedReminders(folderPath: string, filePath: string) {
			const key = `${folderPath}\0${filePath}`;
			const cached = reminderCache.get(key);
			if (cached) cached.remindersJson = '{not json';
		},
		readCurrentFile(path: string): string | null {
			const storageKey = files.get(path);
			const entry = storageKey ? store.get(storageKey) : null;
			return entry ? new TextDecoder().decode(entry.body) : null;
		},
	};
}
