/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { createReadingNote, updateReadingNote } from '@/reading/core/notes';
import { commitFileDelete } from '../sync/mutations';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { getStoredFileRow } from '../sync/storage';
import type { ReadingItem } from '@/reading/core/model';
import type { EncryptionServerState } from '@/encryption/server-state';
import { ensureReadingIndex } from './library-index';
import { createVaultKeyBundle } from '@/encryption/key-bundle';
import { importEncryptionSecret } from '@/encryption/envelope';
import { deriveReadingSearchKey, hashedQueryTerms } from '@/encryption/reading-search';
import { sealFile } from '@/encryption/file-codec';
import { readingUploadCard } from '@/reading/core/reading-card-upload';
import { openReadingCard } from '@/reading/core/reading-card';
import { readStoredNote } from './common';

const principal = { tokenId: 'vault', scope: 'vault' as const };
const items = async (query = '') => {
	const response = await handleReadingRoute(new Request(`https://test/reading/items?${query}`), env, principal);
	expect(response.status).toBe(200);
	return await response.json() as { items: ReadingItem[]; cursor: string | null };
};
const titles = async (query = '') => (await items(query)).items.map(item => item.title);
let day = 1;
async function seed(title: string, path = `Reading/${title}.md`) {
	const note = createReadingNote({ id: crypto.randomUUID(), url: `https://example.invalid/${encodeURIComponent(title)}`, title, savedAt: new Date(Date.UTC(2026, 0, 1) + day++ * 60_000).toISOString() });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note, null);
	return { path, note };
}
const termCount = async () => (await env.DB.prepare('SELECT count(*) AS n FROM note_terms').first<{ n: number }>())!.n;

beforeEach(async () => {
	day = 1;
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,0,'Reading','g','r')").run();
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
	// The first read builds the index; later commits keep it current in their own batch.
	await items();
});
afterEach(async () => { await reset(); });

it('lists newest first and finds titles by word prefixes, ignoring case and accents', async () => {
	await seed('Learning JavaScript');
	await seed('Café culture in Paris');
	await seed('Java memory model');
	expect(await titles('section=inbox')).toEqual(['Java memory model', 'Café culture in Paris', 'Learning JavaScript']);
	expect(await titles('q=jav')).toEqual(['Java memory model', 'Learning JavaScript']);
	expect(await titles('q=JAVA%20mem')).toEqual(['Java memory model']);
	expect(await titles('q=cafe')).toEqual(['Café culture in Paris']);
	expect(await titles('q=python')).toEqual([]);
});

it('filters sections, tags and links, and keeps terms when only status changes', async () => {
	const { path, note } = await seed('Rust ownership');
	await seed('Other article');
	const id = note.match(/crate_reading_id: "?([0-9a-f-]+)/)![1]!;
	const before = await termCount();
	const file = (await getStoredFileRow(env.DB, path))!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, updateReadingNote(note, id, { favorite: true, reading_status: 'archived', tags: ['Systems'] }), file.hash);
	expect(await titles('section=inbox')).toEqual(['Other article']);
	expect(await titles('section=archived')).toEqual(['Rust ownership']);
	expect(await titles('section=favorites&q=rust')).toEqual(['Rust ownership']);
	expect(await titles('section=archived&tag=systems')).toEqual(['Rust ownership']);
	expect(await titles(`section=archived&url=${encodeURIComponent('https://example.invalid/Rust%20ownership#part')}`)).toEqual(['Rust ownership']);
	// A tag adds one term; the title terms stay as they were.
	expect(await termCount()).toBe(before + 1);
});

it('pages by cursor and removes a deleted note from search', async () => {
	for (let index = 0; index < 55; index++) await seed(`Note ${index}`);
	const first = await items('q=note');
	expect(first.items).toHaveLength(50);
	const second = await items(`q=note&cursor=${encodeURIComponent(first.cursor!)}`);
	expect(second.items.map(item => item.title)).toEqual(['Note 4', 'Note 3', 'Note 2', 'Note 1', 'Note 0']);
	const file = (await getStoredFileRow(env.DB, 'Reading/Note 0.md'))!;
	await commitFileDelete(env.DB, { path: 'Reading/Note 0.md', expectedHash: file.hash, expectedRevision: file.storageKey, previousFile: file });
	expect((await items('q=note&cursor=' + encodeURIComponent(first.cursor!))).items).toHaveLength(4);
	expect(await env.DB.prepare("SELECT count(*) AS n FROM note_terms WHERE portable_path = 'reading/note 0.md'").first()).toMatchObject({ n: 0 });
});

it('lists an encrypted note from the card its upload carries, and keeps that card for an upload without one', async () => {
	const bundle = await createVaultKeyBundle(), key = await importEncryptionSecret(bundle.vault);
	const keys = { vaultId: bundle.vaultId, key, keyGeneration: 1, searchKey: await deriveReadingSearchKey(bundle.vaultId, bundle.vault) };
	const upload = async (title: string, card = true) => {
		const content = createReadingNote({ id: '00000000-0000-4000-8000-000000000001', url: 'https://example.invalid/e', title, savedAt: '2026-01-01T00:00:00.000Z' });
		const bytes = new TextEncoder().encode(content);
		const publicData = card ? await readingUploadCard('Reading', 'Reading/plain name.md', 'Reading/tag.md', bytes, keys) : null;
		const sealed = await sealFile({ path: 'Reading/plain name.md', content: bytes, contentType: 'text/markdown', publicData }, { vaultId: bundle.vaultId, scopeId: 'vault', key });
		const previous = await getStoredFileRow(env.DB, 'Reading/tag.md');
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/tag.md', new TextDecoder().decode(sealed.bytes), previous?.hash ?? null);
	};
	const encrypted = { encryption: { mode: 'active' } as unknown as EncryptionServerState };
	const route = (query: string) => handleReadingRoute(new Request(`https://test/reading/items?${query}`), env, principal, encrypted);
	const listed = async (query: string) => ((await (await route(query)).json()) as { cards: Array<{ card: string; stale: boolean }> }).cards;
	await upload('Encrypted title');
	const [found] = await listed(`section=inbox&${(await hashedQueryTerms(keys.searchKey, { q: 'encry' })).map(term => `term=${term}`).join('&')}`);
	expect((await openReadingCard(found!.card, 'Reading/tag.md', keys)).item.title).toBe('Encrypted title');
	expect(JSON.stringify((await env.DB.prepare('SELECT * FROM reading_items').all()).results)).not.toContain('Encrypted title');
	// An upload without a card keeps the last one, marked stale.
	await upload('Renamed', false);
	expect(await listed('section=inbox')).toMatchObject([{ stale: true }]);
});

it('rebuilds an index of encrypted notes as rows waiting for cards', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/one.md', 'CRATE-E2EE/1\n{}', null);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/two.md', 'CRATE-E2EE/1\n{"b":1}', null);
	await env.DB.prepare('DELETE FROM reading_index').run();
	const policy = { enabled: 0, folder_path: 'Reading', generation: 'g', revision: 'r' };
	expect((await ensureReadingIndex(env, policy, file => readStoredNote(env, file), undefined, true)).state).toBe('complete');
	expect((await env.DB.prepare('SELECT path, stale FROM reading_items ORDER BY path').all()).results).toEqual([{ path: 'Reading/one.md', stale: 1 }, { path: 'Reading/two.md', stale: 1 }]);
	// A plaintext rebuild recognises encrypted bytes too.
	await env.DB.prepare('DELETE FROM reading_index').run();
	expect((await ensureReadingIndex(env, policy, file => readStoredNote(env, file))).state).toBe('complete');
	expect((await env.DB.prepare('SELECT count(*) AS n FROM reading_items WHERE stale = 1').first())).toEqual({ n: 2 });
});
