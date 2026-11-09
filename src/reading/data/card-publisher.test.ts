import { expect, it, vi } from 'vitest';
import { createReadingNote } from '../core/notes';
import { openReadingCard } from '../core/reading-card';
import { createVaultKeyBundle } from '@/encryption/key-bundle';
import { importEncryptionSecret } from '@/encryption/envelope';
import { deriveReadingSearchKey, hashedQueryTerms } from '@/encryption/reading-search';
import { ReadingCardPublisher, type ReadingCardServer } from './card-publisher';

const note = (n: number) => createReadingNote({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, url: `https://example.com/${n}`, title: `Article ${n}`, savedAt: '2026-01-01T00:00:00.000Z' });

async function setup(stale: string[]) {
	const bundle = await createVaultKeyBundle();
	const keys = { vaultId: bundle.vaultId, key: await importEncryptionSecret(bundle.vault), keyGeneration: 1, searchKey: await deriveReadingSearchKey(bundle.vaultId, bundle.vault) };
	const files = [1, 2, 3].map(n => ({ path: `Reading/${n}.md`, text: note(n) })).concat({ path: 'Other/4.md', text: note(4) });
	const posted: Array<Record<string, unknown>> = [];
	const calls = {
		encryptedServerPath: vi.fn(async (path: string) => `wire/${path.split('/').pop()}`),
		staleReadingCards: vi.fn(async (after: string) => after ? { files: [], cursor: null } : { files: stale.map(path => ({ path, revision: `r-${path}` })), cursor: stale.length ? 'next' : null }),
		postReadingCards: vi.fn(async (cards: unknown[]) => { posted.push(...cards as Array<Record<string, unknown>>); }),
	};
	const server: ReadingCardServer = { readingCardKeys: () => keys, ...calls };
	const vault = { files: () => files.map(({ path }) => ({ path })) as never, read: async (file: { path: string }) => files.find(entry => entry.path === file.path)!.text };
	return { keys, server, calls, posted, publisher: new ReadingCardPublisher(vault, 'Reading') };
}

it('posts sealed cards and hashed terms for stale notes it holds in sync', async () => {
	const { keys, server, posted, publisher } = await setup(['wire/1.md', 'wire/2.md', 'wire/unknown.md']);
	// Note 2 has a local change waiting to upload, so its card would not describe the server copy.
	expect(await publisher.publish(server, path => path !== 'Reading/2.md')).toBe(1);
	expect(posted).toHaveLength(1);
	expect(posted[0]).toMatchObject({ path: 'wire/1.md', revision: 'r-wire/1.md', status: 'inbox', favorite: false, highlighted: false });
	expect((await openReadingCard(posted[0]!.card as string, 'wire/1.md', keys)).item).toMatchObject({ title: 'Article 1', path: 'Reading/1.md' });
	const query = await hashedQueryTerms(keys.searchKey, { q: 'article' });
	expect(query.every(term => (posted[0]!.terms as string[]).includes(term))).toBe(true);
});

it('maps notes to server paths only when something is stale', async () => {
	const { server, calls, publisher } = await setup([]);
	expect(await publisher.publish(server, () => true)).toBe(0);
	expect(calls.encryptedServerPath).not.toHaveBeenCalled();
	expect(calls.postReadingCards).not.toHaveBeenCalled();
});

it('posts nothing in an unencrypted vault', async () => {
	const { server, calls, publisher } = await setup(['wire/1.md']);
	expect(await publisher.publish({ ...server, readingCardKeys: () => null }, () => true)).toBe(0);
	expect(calls.staleReadingCards).not.toHaveBeenCalled();
});
