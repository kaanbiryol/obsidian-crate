import { describe, expect, it, vi } from 'vitest';
import { sha256HexBytes } from './auth';
import { handleCreateReminder } from './reminders-web/routes/create';
import { handleDeleteReminder } from './reminders-web/routes/delete';
import { handleListReminders } from './reminders-web/routes/list';
import { handleReorderReminders } from './reminders-web/routes/reorder';
import { handleUpdateReminder } from './reminders-web/routes/update';
import { saveReminderFileCache } from './reminders-web/reminder-cache';
import { scanReminderMarkdownFile } from './reminders-web/scan';

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
					if (sql.includes('FROM files WHERE path LIKE')) {
						const prefix = getBoundString(statement._args, 0).slice(0, -1);
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
					const sourcePath = getBoundString(statement._args, 5);
					const sourceExpectedHash = getBoundString(statement._args, 6);
					if (!files.has(destinationPath) && hashes.get(sourcePath) === sourceExpectedHash) {
						files.set(destinationPath, getBoundString(statement._args, 3));
						hashes.set(destinationPath, getBoundString(statement._args, 1));
						sizes.set(destinationPath, Number(statement._args[2]));
						options?.committedPaths?.push(destinationPath);
						changes = 1;
					}
				} else if (statement._sql.includes('atomic-destination-update')) {
					const destinationPath = getBoundString(statement._args, 3);
					const sourcePath = getBoundString(statement._args, 5);
					if (
						hashes.get(destinationPath) === getBoundString(statement._args, 4)
						&& hashes.get(sourcePath) === getBoundString(statement._args, 6)
					) {
						files.set(destinationPath, getBoundString(statement._args, 2));
						hashes.set(destinationPath, getBoundString(statement._args, 0));
						sizes.set(destinationPath, Number(statement._args[1]));
						options?.committedPaths?.push(destinationPath);
						changes = 1;
					}
				} else if (statement._sql.includes('atomic-source-update')) {
					const sourcePath = getBoundString(statement._args, 3);
					const destinationPath = getBoundString(statement._args, 5);
					if (
						hashes.get(sourcePath) === getBoundString(statement._args, 4)
						&& files.get(destinationPath) === getBoundString(statement._args, 6)
					) {
						files.set(sourcePath, getBoundString(statement._args, 2));
						hashes.set(sourcePath, getBoundString(statement._args, 0));
						sizes.set(sourcePath, Number(statement._args[1]));
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
				} else if (statement._sql.includes('INSERT INTO files (path, hash, size, modified, storage_key)')) {
					const path = getBoundString(statement._args, 0);
					if (!statement._sql.includes('DO NOTHING') || !files.has(path)) {
						files.set(path, getBoundString(statement._args, 3));
						hashes.set(path, getBoundString(statement._args, 1));
						sizes.set(path, Number(statement._args[2]));
						options?.committedPaths?.push(path);
						changes = 1;
					}
				} else if (statement._sql.startsWith('UPDATE files')) {
					const path = getBoundString(statement._args, 3);
					if (hashes.get(path) === getBoundString(statement._args, 4)) {
						files.set(path, getBoundString(statement._args, 2));
						hashes.set(path, getBoundString(statement._args, 0));
						sizes.set(path, Number(statement._args[1]));
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

async function createEnv(input: {
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

describe('reminders web handlers', () => {
	it('lists reminders from markdown files in the configured folder', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n- [x] Done task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		const result = await response.json() as { reminders: Array<{ id: string }>; projects: string[] };
		expect(result.reminders.map((reminder) => reminder.id)).toEqual(['r1', 'r2']);
		expect(result.projects).toEqual(['Inbox']);
		expect(result.reminders[0]).not.toHaveProperty('projectColor');
	});

	it('warms a cold reminder index across bounded requests', async () => {
		const bucketEntries: Record<string, string> = {};
		const files: Record<string, null> = {};
		for (let index = 0; index < 25; index += 1) {
			const path = `Reminders/Project-${String(index).padStart(2, '0')}.md`;
			bucketEntries[`files/${path}`] = `# Project ${index}\n\n- [ ] Task ${index} <!-- crate-id:r-${index} -->\n`;
			files[path] = null;
		}
		const workspace = await createEnv({ bucketEntries, files });
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;
		const dbBatch = workspace.env.DB.batch as ReturnType<typeof vi.fn>;

		const warmingResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		expect(warmingResponse.status).toBe(202);
		expect(await warmingResponse.json()).toEqual({ warming: true, remainingFiles: 5 });
		expect(bucketGet).toHaveBeenCalledTimes(20);

		const readyResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		expect(readyResponse.status).toBe(200);
		const result = await readyResponse.json() as { reminders: Array<{ id: string }> };
		expect(result.reminders).toHaveLength(25);
		expect(bucketGet).toHaveBeenCalledTimes(25);
		expect(Math.max(...dbBatch.mock.calls.map(call => (call[0] as unknown[]).length))).toBeLessThanOrEqual(20);
	});

	it('returns 304 from file metadata without reading markdown objects again', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;
		const firstResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const etag = firstResponse.headers.get('ETag');
		expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
		expect(bucketGet).toHaveBeenCalledTimes(2);

		const secondResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders', {
				headers: { 'If-None-Match': etag ?? '' },
			}),
			workspace.env as never,
		);

		expect(secondResponse.status).toBe(304);
		expect(bucketGet).toHaveBeenCalledTimes(2);
	});

	it('reuses cached parses when the client requests a full response again', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(2);
		const result = await response.json() as { reminders: Array<{ id: string }> };
		expect(result.reminders.map((reminder) => reminder.id)).toEqual(['r1', 'r2']);
	});

	it('reads and reparses only the file whose hash changed', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		await workspace.replaceCurrentFile(
			'Reminders/Work.md',
			'# Work\n\n- [ ] Updated task <!-- crate-id:r2 -->\n- [ ] Added task <!-- crate-id:r3 -->\n',
		);
		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(bucketGet).toHaveBeenCalledTimes(3);
		const result = await response.json() as { reminders: Array<{ id: string; content: string }> };
		expect(result.reminders).toMatchObject([
			{ id: 'r1', content: 'First task' },
			{ id: 'r2', content: 'Updated task' },
			{ id: 'r3', content: 'Added task' },
		]);
	});

	it('reparses cache entries with an old parser version or invalid JSON', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		workspace.setCachedParserVersion('Reminders', 'Reminders/Inbox.md', 0);
		workspace.corruptCachedReminders('Reminders', 'Reminders/Work.md');
		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(4);
	});

	it('does not let a stale parser overwrite a newer file cache entry', async () => {
		const originalContent = '# Inbox\n\n- [ ] Original task <!-- crate-id:r1 -->\n';
		const workspace = await createEnv({
			bucketEntries: { 'files/Reminders/Inbox.md': originalContent },
			files: { 'Reminders/Inbox.md': null },
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const oldHash = workspace.getCurrentHash('Reminders/Inbox.md');
		expect(oldHash).toBeTruthy();

		await workspace.replaceCurrentFile(
			'Reminders/Inbox.md',
			'# Inbox\n\n- [ ] Current task <!-- crate-id:r1 -->\n',
		);
		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		await saveReminderFileCache(
			workspace.env.DB as never,
			'Reminders',
			'Reminders/Inbox.md',
			oldHash ?? '',
			scanReminderMarkdownFile('Reminders/Inbox.md', originalContent, 'Reminders'),
		);

		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const result = await response.json() as { reminders: Array<{ content: string }> };
		expect(result.reminders.map((reminder) => reminder.content)).toEqual(['Current task']);
		expect(bucketGet).toHaveBeenCalledTimes(2);
	});

	it('updates the parsed cache eagerly after a reminder mutation', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
			},
			files: { 'Reminders/Inbox.md': null },
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		const updateResponse = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					content: 'Updated task',
				}),
			}),
			workspace.env as never,
		);
		expect(updateResponse.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(1);

		const listResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const result = await listResponse.json() as { reminders: Array<{ content: string }> };
		expect(result.reminders.map((reminder) => reminder.content)).toEqual(['Updated task']);
		expect(bucketGet).toHaveBeenCalledTimes(1);
	});

	it('updates a known source file without scanning unrelated project files', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Work task <!-- crate-id:r-work -->\n',
				'files/Reminders/Home.md': '# Home\n\n- [ ] Home task <!-- crate-id:r-home -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
				'Reminders/Home.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		const response = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					content: 'Updated task',
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(1);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Updated task');
		const result = await response.json() as { reminder?: { id: string; content: string; filePath: string } };
		expect(result.reminder).toMatchObject({
			id: 'r-existing',
			content: 'Updated task',
			filePath: 'Reminders/Inbox.md',
		});
	});

	it('requires a source file path for reminder mutations', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
			},
			files: { 'Reminders/Inbox.md': null },
		});

		const response = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-existing',
					content: 'Updated task',
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Valid filePath required' });
		expect(workspace.env.BUCKET.get).not.toHaveBeenCalled();
	});

	it('creates and deletes reminders against the source markdown files', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const createResponse = await handleCreateReminder(
			new Request('https://worker.test/reminders/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					content: 'Check article',
					project: 'Inbox',
					dueDatetime: '2099-01-10T10:00:00.000Z',
				}),
			}),
			workspace.env as never,
		);

		expect(createResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Check article');
		expect(workspace.scheduled.size).toBe(1);

		const listResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const listResult = await listResponse.json() as { reminders: Array<{ id: string }> };
		const createdId = listResult.reminders[0]?.id;
		expect(createdId).toBeTruthy();

		const deleteResponse = await handleDeleteReminder(
			new Request('https://worker.test/reminders/delete', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: createdId,
					filePath: 'Reminders/Inbox.md',
				}),
			}),
			workspace.env as never,
		);

		expect(deleteResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).not.toContain('Check article');
		expect(workspace.scheduled.size).toBe(0);
	});

	it('rejects unsafe project paths and invalid all-day notification times', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const unsafeProjectResponse = await handleCreateReminder(
			new Request('https://worker.test/reminders/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					content: 'Escape folder',
					project: '../Secrets',
				}),
			}),
			workspace.env as never,
		);

		expect(unsafeProjectResponse.status).toBe(400);
		expect(await unsafeProjectResponse.json()).toEqual({ error: 'Invalid project' });
		expect(workspace.files.has('Reminders/../Secrets.md')).toBe(false);

		const invalidTimeResponse = await handleCreateReminder(
			new Request('https://worker.test/reminders/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					content: 'Bad notification time',
					allDayNotificationTime: '25:00',
				}),
			}),
			workspace.env as never,
		);

		expect(invalidTimeResponse.status).toBe(400);
		expect(await invalidTimeResponse.json()).toEqual({ error: 'Invalid allDayNotificationTime' });
	});

	it('persists recurrence from create and update payloads', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const createResponse = await handleCreateReminder(
			new Request('https://worker.test/reminders/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					content: 'Recurring create',
					project: 'Inbox',
					recurrence: { frequency: 'daily', hour: 9, minute: 0 },
				}),
			}),
			workspace.env as never,
		);

		expect(createResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Recurring create daily 09:00');

		const addRecurrenceResponse = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					recurrence: { frequency: 'weekly', daysOfWeek: [1, 3], hour: 10, minute: 30 },
				}),
			}),
			workspace.env as never,
		);

		expect(addRecurrenceResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Existing task every Mon, Wed 10:30');

		const removeRecurrenceResponse = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					recurrence: null,
				}),
			}),
			workspace.env as never,
		);

		expect(removeRecurrenceResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Existing task');
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('<!-- crate-id:r-existing -->');
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).not.toContain('every Mon, Wed 10:30');
	});

	it('moves completed reminders by committing both files atomically', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [x] Done task Jan 1, 2026 <!-- crate-id:r-done -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const response = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-done',
					filePath: 'Reminders/Inbox.md',
					project: 'Personal',
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(workspace.committedPaths).toEqual([
			'Reminders/Personal.md',
			'Reminders/Inbox.md',
		]);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).not.toContain('Done task');
		expect(workspace.readCurrentFile('Reminders/Personal.md')).toContain('- [x] Done task Jan 1, 2026 <!-- crate-id:r-done -->');
	});

	it('leaves both files unchanged when the source CAS fails during a move', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Keep task Jan 1, 2026 <!-- crate-id:r-keep -->\n',
			},
			files: { 'Reminders/Inbox.md': null },
			atomicSourceConflictPath: 'Reminders/Inbox.md',
		});

		await expect(handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-keep',
					filePath: 'Reminders/Inbox.md',
					project: 'Personal',
				}),
			}),
			workspace.env as never,
		)).rejects.toMatchObject({ path: 'Reminders/Inbox.md' });

		expect(workspace.committedPaths).toEqual([]);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Keep task');
		expect(workspace.readCurrentFile('Reminders/Personal.md')).toBeNull();
	});

	it('keeps the source reminder when the destination move write fails', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Keep task Jan 1, 2026 <!-- crate-id:r-keep -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
			failPutWhen: (_key, content) => content.includes('# Personal') && content.includes('Keep task'),
		});

		await expect(handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					id: 'r-keep',
					filePath: 'Reminders/Inbox.md',
					project: 'Personal',
				}),
			}),
			workspace.env as never,
		)).rejects.toThrow('forced put failure');

		expect(workspace.committedPaths).toEqual([]);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Keep task');
		expect(workspace.readCurrentFile('Reminders/Personal.md')).toBeNull();
	});

	it('reorders active reminders while leaving completed reminders at the bottom', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First <!-- crate-id:r1 -->\n- [ ] Second <!-- crate-id:r2 -->\n- [x] Done <!-- crate-id:r3 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const response = await handleReorderReminders(
			new Request('https://worker.test/reminders/reorder', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: 'Reminders',
					project: 'Inbox',
					orderedIds: ['r2', 'r1'],
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('- [ ] Second <!-- crate-id:r2 -->\n- [ ] First <!-- crate-id:r1 -->\n- [x] Done <!-- crate-id:r3 -->');
	});
});
