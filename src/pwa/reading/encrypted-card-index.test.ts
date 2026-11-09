import { beforeAll, expect, it, vi } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from '@/encryption/envelope';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { PathTags } from '@/encryption/path-tags';
import { EncryptedReadingApi } from './encrypted-api';
import { createReadingNote, parseReadingNote } from '../../reading/core/notes';
import { buildReadingIndexShards, sealReadingIndexManifest, storedReadingIndexShard, type ReadingIndexCard } from '../../reading/core/card-index';
import { sha256Hex } from '@/platform/sha256';
import { READING_INDEX_SHARDS, type ReadingIndexManifest } from '@/protocol/reading-index';
import { isReadingIndexCard } from './storage/cache';

let authority: FileEncryptionAuthority, paths: PathTags, wireFolder: string;
beforeAll(async () => {
	authority = { vaultId: 'vault-a', scopeId: 'vault', key: await importEncryptionSecret(generateEncryptionSecret()) };
	paths = await PathTags.fromSecret('vault-a', generateEncryptionSecret());
	wireFolder = await paths.wire('Reading');
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (n: number, title: string) => createReadingNote({ id: id(n), url: `https://example.com/${n}`, title, savedAt: new Date(Date.UTC(2026, 0, n)).toISOString() }) + `\n${title} text.\n`;
async function card(n: number, title = `Article ${n}`): Promise<ReadingIndexCard> {
	const path = `Reading/${n}.md`;
	return { ...parseReadingNote(text(n, title))!, path, wire: await paths.wire(path) };
}
async function sealed(n: number, title: string, revision: string) {
	const path = `Reading/${n}.md`;
	const file = await sealFile({ path, content: new TextEncoder().encode(text(n, title)), contentType: 'text/markdown', publicData: null }, authority);
	return { bytes: file.bytes, file: { path: await paths.wire(path), hash: file.hash, size: file.bytes.length, revision } };
}
/** What Obsidian published: sealed shards and the sealed manifest naming them. */
async function published(cards: ReadingIndexCard[], basis: number) {
	const keys = { vaultId: authority.vaultId, key: authority.key, keyGeneration: 1 };
	const built = await buildReadingIndexShards(cards), stored = new Map<string, Uint8Array>();
	const shards = await Promise.all(built.map(async ({ json }, shard) => {
		if (!json) return '';
		const bytes = await storedReadingIndexShard(json, shard, 'gen', keys), hash = await sha256Hex(bytes);
		stored.set(hash, bytes);
		return hash;
	}));
	const manifest: ReadingIndexManifest = { format: 1, generation: 'gen', basis, shards, keyGeneration: 1,
		sealed: await sealReadingIndexManifest({ generation: 'gen', basis, shards, content: built.map(shard => shard.content) }, keys) };
	return { manifest, stored };
}
function harness(route: (path: string, headers?: Record<string, string>) => Response | Promise<Response>) {
	const request = vi.fn(async (path: string, _body?: string, headers?: Record<string, string>) => route(path, headers));
	const api = new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request,
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message),
		isCard: (value): value is ReadingIndexCard => isReadingIndexCard(value, 'Reading') });
	return { api, request, paths: () => request.mock.calls.map(([path]) => path.split('?')[0]) };
}

it('lists the whole library from the index, opening only notes changed after its basis', async () => {
	const [one, two, three] = await Promise.all([card(1), card(2), card(3)]) as [ReadingIndexCard & { wire: string }, ReadingIndexCard, ReadingIndexCard & { wire: string }];
	const { manifest, stored } = await published([one, two, three], 10);
	const edited = await sealed(1, 'Edited elsewhere', 'r2');
	let tail = { lastSeq: 12, notes: [edited.file], removed: [three.wire] };
	const h = harness((path, headers) => {
		if (path === '/reading/index') return headers?.['If-None-Match'] ? new Response(null, { status: 304 }) : Response.json({ manifest, etag: 'e1' }, { headers: { ETag: '"e1"' } });
		if (path.startsWith('/reading/index/shard?')) return new Response(stored.get(new URL(path, 'https://x').searchParams.get('hash')!) as BodyInit);
		if (path.startsWith('/reading/index/changes?')) return Response.json(tail);
		if (path.startsWith('/reading/encrypted-file?')) return new Response(edited.bytes as BodyInit);
		throw new Error(`Unexpected ${path}`);
	});
	const list = await h.api.request('/reading/list') as { items: Array<{ title: string; path: string }>; issues: unknown[] };
	expect(list.items.map(item => item.title).sort()).toEqual(['Article 2', 'Edited elsewhere']);
	expect(list.issues).toEqual([]);
	// Before: every refresh listed the whole inventory and a new device downloaded every note.
	expect(h.paths()).not.toContain('/reading/encrypted-files');
	expect(h.paths().filter(path => path === '/reading/encrypted-file')).toHaveLength(1);
	// An unchanged index is a conditional manifest read and a short tail; nothing downloads.
	h.request.mockClear();
	tail = { lastSeq: 12, notes: [], removed: [] };
	expect(await h.api.request('/reading/list')).toBe(list);
	expect(h.paths()).toEqual(['/reading/index', '/reading/index/changes']);
	expect(h.request.mock.calls[1]![0]).toContain('after=12');
});

it('reads one note\'s current server entry before opening it', async () => {
	const two = await card(2);
	const { manifest, stored } = await published([two], 4);
	const current = await sealed(2, 'Article 2', 'r9');
	const h = harness(path => {
		if (path === '/reading/index') return Response.json({ manifest, etag: 'e1' }, { headers: { ETag: '"e1"' } });
		if (path.startsWith('/reading/index/shard?')) return new Response([...stored.values()][0] as BodyInit);
		if (path.startsWith('/reading/index/changes?')) return Response.json({ lastSeq: 4, notes: [], removed: [] });
		if (path.startsWith('/reading/index/file?')) return Response.json({ file: current.file });
		if (path.startsWith('/reading/encrypted-file?')) return new Response(current.bytes as BodyInit);
		throw new Error(`Unexpected ${path}`);
	});
	const opened = await h.api.item(id(2));
	expect(opened?.article.markdown).toContain('Article 2 text.');
	expect(h.paths()).toContain('/reading/index/file');
	expect(h.paths()).not.toContain('/reading/encrypted-files');
});

it('falls back to the file listing without an index, and flags an index too old to replay', async () => {
	const fallback = harness(path => {
		if (path === '/reading/index') return Response.json({ error: 'Missing' }, { status: 404 });
		if (path.startsWith('/reading/encrypted-files')) return Response.json({ files: [], nextCursor: null, sequence: 1, generation: 1 });
		throw new Error(`Unexpected ${path}`);
	});
	expect((await fallback.api.request('/reading/list') as { items: unknown[] }).items).toEqual([]);
	expect(fallback.paths()).toContain('/reading/encrypted-files');

	const { manifest, stored } = await published([await card(1)], 1);
	const old = harness(path => {
		if (path === '/reading/index') return Response.json({ manifest, etag: 'e1' }, { headers: { ETag: '"e1"' } });
		if (path.startsWith('/reading/index/shard?')) return new Response([...stored.values()][0] as BodyInit);
		if (path.startsWith('/reading/index/changes?')) return Response.json({ expired: true, lastSeq: 90_000 });
		throw new Error(`Unexpected ${path}`);
	});
	const list = await old.api.request('/reading/list') as { items: unknown[]; issues: Array<{ message: string }> };
	expect(list.items).toHaveLength(1);
	expect(list.issues[0]?.message).toContain('Open Obsidian');
});

it('refuses a manifest the server changed', async () => {
	const { manifest } = await published([await card(1)], 1);
	const forged = { ...manifest, shards: Array.from({ length: READING_INDEX_SHARDS }, () => '') };
	const h = harness(path => {
		if (path === '/reading/index') return Response.json({ manifest: forged, etag: 'e1' });
		throw new Error(`Unexpected ${path}`);
	});
	await expect(h.api.request('/reading/list')).rejects.toThrow('verification');
});
