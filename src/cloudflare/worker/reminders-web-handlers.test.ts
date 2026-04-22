import { describe, expect, it, vi } from 'vitest';
import {
	handleCreateReminder,
	handleDeleteReminder,
	handleListReminders,
	handleReorderReminders,
} from './reminders-web-handlers';

type StoredObject = {
	body: ArrayBuffer;
	httpMetadata?: { contentType?: string };
	customMetadata?: { hash?: string };
};

function createBucket(initialEntries: Record<string, string> = {}) {
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
			delete: vi.fn(async (key: string) => {
				store.delete(key);
			}),
		},
	};
}

function createDb(options?: { files?: Record<string, string | null> }) {
	const files = new Map<string, string | null>(Object.entries(options?.files ?? {}));
	const scheduled = new Map<string, { content: string; project: string | null; dueDatetime: string }>();

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
				all: vi.fn(async () => {
					if (sql.includes('PRAGMA table_info(files)')) {
						return { results: [{ name: 'path' }, { name: 'storage_key' }] };
					}
					if (sql.includes('PRAGMA table_info(auth_tokens)')) {
						return { results: [{ name: 'id' }, { name: 'token_hash' }, { name: 'device_id' }, { name: 'device_name' }, { name: 'platform' }, { name: 'last_seen_at' }] };
					}
					if (sql.includes('SELECT path FROM files WHERE path LIKE')) {
						const prefix = getBoundString(statement._args, 0).slice(0, -1);
						return {
							results: Array.from(files.keys())
								.filter((path) => path.startsWith(prefix) && path.toLowerCase().endsWith('.md'))
								.sort()
								.map((path) => ({ path })),
						};
					}
					return { results: [] };
				}),
			};
			return statement;
		}),
		batch: vi.fn(async (statements: Array<{ _sql: string; _args: unknown[] }>) => {
			for (const statement of statements) {
				if (statement._sql.includes('INSERT OR REPLACE INTO files')) {
					const path = getBoundString(statement._args, 0);
					const storageKey = typeof statement._args[3] === 'string' ? statement._args[3] : null;
					files.set(path, storageKey);
				}
				if (statement._sql.includes('DELETE FROM files WHERE path = ?')) {
					files.delete(getBoundString(statement._args, 0));
				}
			}
			return [];
		}),
		exec: vi.fn(async () => ({})),
	};

	return { db, files, scheduled };
}

function createEnv(input: {
	bucketEntries: Record<string, string>;
	files: Record<string, string | null>;
}) {
	const { bucket, store } = createBucket(input.bucketEntries);
	const { db, files, scheduled } = createDb({ files: input.files });

	return {
		env: {
			BUCKET: bucket,
			DB: db,
			AUTH_TOKEN: 'secret-token',
			CF_ACCOUNT_ID: '',
			CF_WORKER_NAME: '',
			CF_BUCKET_NAME: '',
			CF_DATABASE_ID: '',
			REMINDER_ALARMS: {
				idFromName: vi.fn((name: string) => name),
				get: vi.fn((name: string) => ({
					fetch: vi.fn(async (url: string, init?: RequestInit) => {
						if (url.endsWith('/schedule') && init?.body) {
							const body = JSON.parse(String(init.body)) as { reminderId: string; content: string; project?: string; dueDatetime: string };
							scheduled.set(name, {
								content: body.content,
								project: body.project ?? null,
								dueDatetime: body.dueDatetime,
							});
						}
						if (url.endsWith('/cancel')) {
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
		readCurrentFile(path: string): string | null {
			const storageKey = files.get(path);
			const objectKey = storageKey ?? `files/${path}`;
			const entry = store.get(objectKey);
			return entry ? new TextDecoder().decode(entry.body) : null;
		},
	};
}

describe('reminders web handlers', () => {
	it('lists reminders from markdown files in the configured folder', async () => {
		const workspace = createEnv({
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
	});

	it('creates and deletes reminders against the source markdown files', async () => {
		const workspace = createEnv({
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
				}),
			}),
			workspace.env as never,
		);

		expect(deleteResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).not.toContain('Check article');
		expect(workspace.scheduled.size).toBe(0);
	});

	it('reorders active reminders while leaving completed reminders at the bottom', async () => {
		const workspace = createEnv({
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
