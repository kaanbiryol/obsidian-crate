import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadReading } from './api';
import { commitReadingCache, type ReadingCache } from './storage/storage';
import { type ReadingSession } from './session/session';
import { createReadingNote, parseReadingNote } from '@/reading/core/notes';
import { buildReadingIndexShards } from '@/reading/core/card-index';
import { sha256Hex } from '@/platform/sha256';

vi.mock('./session/encryption-session', () => ({
	prepareReadingEncryption: async () => null,
	readingEncryptionHeaders: () => ({}),
	readingEncryptionKeys: () => null,
	readingNoteFolder: ({ folderPath }: { folderPath: string }) => folderPath,
}));
vi.mock('./session/session', async importOriginal => ({ ...await importOriginal<typeof import('./session/session')>(), assertReadingSession: vi.fn() }));
vi.mock('./storage/storage', () => ({
	commitReadingCache: vi.fn(async (_session: ReadingSession, cache: ReadingCache) => cache),
}));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const item = (n: number, title = `Article ${n}`) => ({ ...parseReadingNote(createReadingNote({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
	url: `https://example.com/${n}`, title, savedAt: new Date(Date.UTC(2026, 0, n)).toISOString() }))!, path: `Reading/${n}.md` });
const requested: string[] = [];

async function serve(tail: unknown) {
	const built = await buildReadingIndexShards([item(1), item(2), item(3)]);
	const stored = new Map<string, string>();
	const shards = await Promise.all(built.map(async ({ json }) => { if (!json) return ''; const hash = await sha256Hex(json); stored.set(hash, json); return hash; }));
	vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
		const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		requested.push(path.split('?')[0]!);
		if (path === '/reading/index') return Response.json({ manifest: { format: 1, generation: 'gen', basis: 7, shards }, etag: 'e1' });
		if (path.startsWith('/reading/index/shard?')) return new Response(stored.get(new URL(path, 'https://x').searchParams.get('hash')!));
		if (path.startsWith('/reading/index/changes?after=7')) return Response.json(tail);
		if (path.startsWith('/reading/list')) return Response.json({ items: [item(9)], issues: [], cursor: null }, { headers: { ETag: '"list"' } });
		throw new Error(`Unexpected ${path}`);
	});
}
beforeEach(() => { vi.clearAllMocks(); requested.length = 0; });
afterEach(() => vi.unstubAllGlobals());

it('loads a first copy from the card index and its tail instead of every list page', async () => {
	await serve({ lastSeq: 9, notes: [item(2, 'Edited')], issues: [], removed: ['Reading/3.md'], changedPaths: ['Reading/2.md', 'Reading/3.md'], revision: '"list-etag"', deltaBase: '9.abc' });
	const cache = await loadReading(session);
	expect(cache.items.map(entry => entry.title).sort()).toEqual(['Article 1', 'Edited']);
	// Later refreshes revalidate and replay the ordinary list delta.
	expect(cache).toMatchObject({ revision: '"list-etag"', deltaBase: '9.abc' });
	expect(requested).not.toContain('/reading/list');
	expect(commitReadingCache).toHaveBeenCalledOnce();
});

it('lists every page when the tail cannot be replayed', async () => {
	await serve({ expired: true });
	const cache = await loadReading(session);
	expect(cache.items.map(entry => entry.title)).toEqual(['Article 9']);
	expect(requested).toContain('/reading/list');
});
