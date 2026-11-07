/**
 * Frozen Reading pending queues (the `pending:<session>` value in the
 * `crate-reading-v1` IndexedDB store) as the released web app saved them. After an
 * update the web app must still load each queued change, and send a dispatched
 * change with its exact saved request body and operation ID.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new version, append an
 * entry below with a new file name (for example `reading-pending.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=reading-pending.v2.json npx vitest run src/pwa/reading/outbox.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or
 * regenerate an existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { afterEach, describe, vi } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { pendingReading, savePendingReading } from './storage/storage';
import { READING_SESSION_KEY, type ReadingSession } from './session/session';
import type { PendingReading } from './outbox';

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../storage/single-store-database', () => ({ openSingleStoreDatabase: async () => ({
	get: async (_store: string, key: string) => values.get(key),
	put: async (_store: string, value: unknown, key: string) => { values.set(key, value); },
	delete: async (_store: string, key: string) => { values.delete(key); },
	getAllKeys: async () => [...values.keys()],
}) }));

interface SavedQueue { session: ReadingSession; values: Record<string, unknown> }

const session: ReadingSession = { id: 'reading-session-1', token: 'synthetic-reading-credential', generation: 'generation-1', folderPath: 'Reading', expiresAt: 1_893_456_000_000 };
const operationId = 'e1_00020757_3c47ab21-6d0e-4f3a-9b8c-2a1d5e7f9c04';

function stubSession(saved: ReadingSession): void {
	vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(saved) : null });
}

async function save(queue: PendingReading[]): Promise<SavedQueue> {
	values.clear();
	stubSession(session);
	await savePendingReading(session, queue);
	return { session, values: Object.fromEntries(values) };
}

async function load(saved: SavedQueue) {
	values.clear();
	for (const [key, value] of Object.entries(saved.values)) values.set(key, value);
	stubSession(saved.session);
	return { pending: await pendingReading(saved.session) };
}

afterEach(() => { vi.unstubAllGlobals(); values.clear(); });

describe('frozen Reading pending queues', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
		{
			// An offline capture that was never sent, a dispatched edit with its exact
			// request body, and a delete the server refused that waits for review.
			file: 'reading-pending.v1.json',
			stored: () => {
				const update = { id: 'article-1', changes: { favorite: true, tags: ['research'] }, before: { favorite: false, tags: [] } };
				return save([
					{ id: '0b6f0f7e-2f43-4d55-9c1e-6a2f6b1c3d01', sessionId: session.id, action: 'capture', queuedAt: '2026-11-07T10:00:00.000Z',
						intent: { url: 'https://example.com/synthetic-article', title: 'Synthetic article', fetchArticle: true } },
					{ id: '1c7a1f8e-3a54-4e66-8d2f-7b3a7c2d4e02', sessionId: session.id, action: 'update', queuedAt: '2026-11-07T10:01:00.000Z',
						intent: update, body: JSON.stringify({ ...update, operationId }), attempts: 1 },
					{ id: '2d8b2a9f-4b65-4f77-9e3a-8c4b8d3e5f03', sessionId: session.id, action: 'delete', queuedAt: '2026-11-07T10:02:00.000Z',
						intent: { id: 'article-2', before: { reading_status: 'inbox', favorite: false }, markdownHash: 'a3f1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80' },
						error: 'This article changed on another device.', review: true, attempts: 3, retryAt: 1_793_000_000_000 },
				]);
			},
			decode: load,
		},
	]);
});
