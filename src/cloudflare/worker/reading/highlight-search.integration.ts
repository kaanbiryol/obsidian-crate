/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { createReadingNote, updateReadingNote } from '@/reading/core/notes';
import { patchReadingFrontmatter, readReadingFrontmatter } from '@/reading/core/frontmatter';
import { readingDocument } from '@/reading/core/markdown';
import { commitFileDelete } from '../sync/mutations';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { getStoredFileRow } from '../sync/storage';
import type { ReadingItem } from '@/reading/core/model';
import type { ReadingHighlight } from '@/reading/core/highlights';
import type { EncryptionServerState } from '@/encryption/server-state';
import { createVaultKeyBundle } from '@/encryption/key-bundle';
import { importEncryptionSecret } from '@/encryption/envelope';
import { deriveReadingSearchKey, hashedQueryTerms } from '@/encryption/reading-search';
import { sealFile } from '@/encryption/file-codec';
import { readingUploadCard } from '@/reading/core/reading-card-upload';
import { openReadingCard, openReadingTagName } from '@/reading/core/reading-card';
import { meterD1Usage } from '../d1/d1-usage';
import { readingItems, readingTags } from './queries';

const principal = { tokenId: 'vault', scope: 'vault' as const };
const policy = { enabled: 0, folder_path: 'Reading', generation: 'g', revision: 'r' };
const get = async <T>(path: string) => {
	const response = await handleReadingRoute(new Request(`https://test/reading/${path}`), env, principal);
	expect(response.status, await response.clone().text()).toBe(200);
	return await response.json() as T;
};
const highlights = async (query = '') => get<{ items: ReadingItem[]; cursor: string | null }>(`items?section=highlights&${query}`);
const titles = async (query = '') => (await highlights(query)).items.map(item => item.title);
const highlightRows = async () => (await env.DB.prepare('SELECT highlighted_at, portable_path FROM highlight_index ORDER BY highlighted_at DESC').all()).results;

let day = 1;
const notes = new Map<string, { path: string; note: string; id: string }>();
// Each note's article holds every passage the tests highlight.
const ARTICLE = 'Patient habits compound. Attention is scarce. One. Two. Three. Secret passage.';
async function seed(title: string, tags: string[] = []) {
	const id = crypto.randomUUID(), path = `Reading/${title}.md`;
	let note = createReadingNote({ id, url: `https://example.invalid/${encodeURIComponent(title)}`, title, savedAt: new Date(Date.UTC(2026, 0, 1) + day++ * 60_000).toISOString() }) + `\n${ARTICLE}\n`;
	if (tags.length) note = patchReadingFrontmatter(note, { tags });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note, null);
	notes.set(title, { path, note, id });
}
/** Highlights placed on the note's article text, as the reader saves them. */
const placed = (note: string, marks: ReadingHighlight[]) => {
	const text = readingDocument(readReadingFrontmatter(note)!.body).text;
	return marks.map(mark => { const start = text.indexOf(mark.text); return { ...mark, start, end: start + mark.text.length }; });
};
async function edit(title: string, changes: { highlights: ReadingHighlight[] }) {
	const current = notes.get(title)!, note = updateReadingNote(current.note, current.id, { highlights: placed(current.note, changes.highlights) });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, current.path, note, (await getStoredFileRow(env.DB, current.path))!.hash);
	notes.set(title, { ...current, note });
}
const highlight = (text: string, createdAt: string, note?: string): ReadingHighlight => ({ start: 0, end: text.length, text, createdAt, ...note ? { note } : {} });

beforeEach(async () => {
	day = 1; notes.clear();
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,0,'Reading','g','r')").run();
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
	await get('items');
});
afterEach(async () => { await reset(); });

it('lists highlighted notes by their newest highlight and finds highlight text, notes, titles and tags', async () => {
	await seed('Old essay', ['Craft']);
	await seed('New essay');
	await seed('Unhighlighted');
	await edit('Old essay', { highlights: [highlight('Patient habits compound', '2026-03-01T00:00:00.000Z', 'Revisit monthly')] });
	await edit('New essay', { highlights: [highlight('Attention is scarce', '2026-02-01T00:00:00.000Z')] });
	// The essay saved first was highlighted last, so it leads.
	expect(await titles()).toEqual(['Old essay', 'New essay']);
	expect(await titles('q=habi')).toEqual(['Old essay']);
	expect(await titles('q=revisit%20patient')).toEqual(['Old essay']);
	expect(await titles('q=new%20essay')).toEqual(['New essay']);
	expect(await titles('q=essay')).toEqual(['Old essay', 'New essay']);
	expect(await titles('tag=craft')).toEqual(['Old essay']);
	expect(await titles('q=bits')).toEqual([]);
	// The other sections still search titles only.
	expect((await get<{ items: ReadingItem[] }>('items?section=inbox&q=habits')).items).toEqual([]);
});

it('moves a note when it gains a highlight and drops it when its highlights or the note go', async () => {
	await seed('First');
	await seed('Second');
	await edit('First', { highlights: [highlight('One', '2026-02-01T00:00:00.000Z')] });
	await edit('Second', { highlights: [highlight('Two', '2026-02-02T00:00:00.000Z')] });
	expect(await titles()).toEqual(['Second', 'First']);
	await edit('First', { highlights: [highlight('One', '2026-02-01T00:00:00.000Z'), highlight('Three', '2026-02-03T00:00:00.000Z')] });
	expect(await titles()).toEqual(['First', 'Second']);
	expect(await highlightRows()).toHaveLength(2);
	await edit('First', { highlights: [] });
	expect(await titles()).toEqual(['Second']);
	const second = notes.get('Second')!, file = (await getStoredFileRow(env.DB, second.path))!;
	await commitFileDelete(env.DB, { path: second.path, expectedHash: file.hash, expectedRevision: file.storageKey, previousFile: file });
	expect(await titles()).toEqual([]);
	expect(await highlightRows()).toEqual([]);
});

it('stops a highlight search after a bounded scan and continues it from the cursor', async () => {
	const statements: D1PreparedStatement[] = [];
	// 2,100 highlighted notes; only the oldest has the word, so the first page scans its cap and finds none.
	for (let n = 0; n < 2100; n++) {
		const path = `reading/${n}.md`, at = new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString(), term = n === 0 ? 'p:rar' : 'p:com';
		statements.push(env.DB.prepare(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, metadata_json, saved_at, status, highlighted, highlighted_at, terms, words)
      VALUES (?, ?, 'r', 'h', 1, ?, ?, ?, 'inbox', 1, ?, '[]', '[]')`).bind(path, `Reading/${n}.md`, crypto.randomUUID(),
			JSON.stringify({ crate_reading_version: 1, crate_reading_id: '00000000-0000-4000-8000-000000000001', title: `Note ${n}`, source_url: 'https://example.invalid/', saved_at: at,
				reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' }), at, at));
		statements.push(env.DB.prepare('INSERT INTO highlight_index(highlighted_at, portable_path, terms, words) VALUES (?, ?, ?, ?)')
			.bind(at, path, JSON.stringify([term]), JSON.stringify([n === 0 ? 'rare' : 'common'])));
	}
	for (let index = 0; index < statements.length; index += 500) await env.DB.batch(statements.slice(index, index + 500));
	const meter = meterD1Usage(env.DB);
	const first = await readingItems({ ...env, DB: meter.db }, policy, false, { section: 'highlights', cursor: '', q: 'rare' }) as { items: ReadingItem[]; cursor: string | null };
	expect(first.items).toEqual([]);
	expect(first.cursor).not.toBeNull();
	// The scan reads its 2,000 rows and, for a short page, a second seek finds where it ended.
	expect(meter.usage.rowsRead).toBeLessThanOrEqual(4100);
	const second = await readingItems(env, policy, false, { section: 'highlights', cursor: first.cursor!, q: 'rare' }) as { items: ReadingItem[]; cursor: string | null };
	expect(second.items.map(item => item.title)).toEqual(['Note 0']);
	expect(second.cursor).toBeNull();
	// Browsing without a search reads about one page.
	const browse = meterD1Usage(env.DB);
	expect((await readingItems({ ...env, DB: browse.db }, policy, false, { section: 'highlights', cursor: '' }) as { items: unknown[] }).items).toHaveLength(50);
	expect(browse.usage.rowsRead).toBeLessThanOrEqual(110);
});

it('ends a Highlights page before its cards pass the size budget', async () => {
	const statements: D1PreparedStatement[] = [];
	for (let n = 0; n < 4; n++) {
		const path = `reading/${n}.md`, at = new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString();
		statements.push(env.DB.prepare(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, saved_at, status, highlighted, highlighted_at, card)
      VALUES (?, ?, 'r', 'h', 1, ?, ?, 'inbox', 1, ?, ?)`).bind(path, `Reading/${n}.md`, crypto.randomUUID(), at, at, JSON.stringify({ card: 'a'.repeat(200_000) })));
		statements.push(env.DB.prepare("INSERT INTO highlight_index(highlighted_at, portable_path, terms) VALUES (?, ?, '[]')").bind(at, path));
	}
	await env.DB.batch(statements);
	const first = await readingItems(env, policy, true, { section: 'highlights', cursor: '' }) as { cards: Array<{ path: string }>; cursor: string | null };
	expect(first.cards.map(card => card.path)).toEqual(['Reading/3.md', 'Reading/2.md']);
	const second = await readingItems(env, policy, true, { section: 'highlights', cursor: first.cursor! }) as { cards: Array<{ path: string }>; cursor: string | null };
	expect(second.cards.map(card => card.path)).toEqual(['Reading/1.md', 'Reading/0.md']);
	expect(second.cursor).toBeNull();
});

it('lists every tag once, reading about one row per tag', async () => {
	for (let n = 0; n < 30; n++) await seed(`Note ${n}`, n % 3 ? ['Systems', `topic-${n % 5}`] : ['Design']);
	const meter = meterD1Usage(env.DB);
	const { tags } = await readingTags({ ...env, DB: meter.db }, false) as { tags: string[] };
	expect(tags).toEqual(['design', 'systems', 'topic-0', 'topic-1', 'topic-2', 'topic-3', 'topic-4']);
	expect(meter.usage.rowsRead).toBeLessThanOrEqual(3 * tags.length);
	expect(await get('tags')).toEqual({ tags });
});

it('lists a section\'s tags most used first with their note counts', async () => {
	await seed('One', ['Systems', 'Design']);
	await seed('Two', ['Systems']);
	await seed('Three', ['Systems', 'Craft']);
	await edit('Two', { highlights: [highlight('Attention is scarce.', '2026-02-01T00:00:00.000Z')] });
	expect(await get('tags?section=inbox')).toEqual({ tags: ['systems', 'craft', 'design'], counts: [3, 1, 1] });
	expect(await get('tags?section=highlights')).toEqual({ tags: ['systems'], counts: [1] });
	expect(await get('tags?section=favorites')).toEqual({ tags: [], counts: [] });
	const response = await handleReadingRoute(new Request('https://test/reading/tags?section=all'), env, principal);
	expect(response.status).toBe(400);
});

it('searches an encrypted vault\'s highlights and lists its sealed tag names while a note has the tag', async () => {
	const bundle = await createVaultKeyBundle(), key = await importEncryptionSecret(bundle.vault);
	const keys = { vaultId: bundle.vaultId, key, keyGeneration: 1, searchKey: await deriveReadingSearchKey(bundle.vaultId, bundle.vault) };
	const upload = async (wire: string, tags: string[], marks: ReadingHighlight[]) => {
		const id = '00000000-0000-4000-8000-00000000000' + wire.length;
		let content = patchReadingFrontmatter(createReadingNote({ id, url: `https://example.invalid/${wire}`, title: `Title ${wire}`, savedAt: '2026-01-01T00:00:00.000Z' }) + `\n${ARTICLE}\n`, { tags });
		content = updateReadingNote(content, id, { highlights: placed(content, marks) });
		const bytes = new TextEncoder().encode(content), plain = `Reading/${wire}.md`;
		const publicData = await readingUploadCard('Reading', plain, `Reading/${wire}.md`, bytes, keys);
		const sealed = await sealFile({ path: plain, content: bytes, publicData }, { vaultId: bundle.vaultId, scopeId: 'vault', key });
		const previous = await getStoredFileRow(env.DB, `Reading/${wire}.md`);
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reading/${wire}.md`, new TextDecoder().decode(sealed.bytes), previous?.hash ?? null);
	};
	const encrypted = { encryption: { mode: 'active' } as unknown as EncryptionServerState };
	const route = async <T>(path: string) => await (await handleReadingRoute(new Request(`https://test/reading/${path}`), env, principal, encrypted)).json() as T;
	const search = async (q: string) => {
		const terms = (await hashedQueryTerms(keys.searchKey, { q })).map(term => `term=${term}`).join('&');
		const { cards } = await route<{ cards: Array<{ card: string; path: string }> }>(`items?section=highlights&${terms}`);
		return await Promise.all(cards.map(async card => (await openReadingCard(card.card, card.path, keys)).item.title));
	};
	await upload('a', ['Private'], [highlight('Secret passage', '2026-02-01T00:00:00.000Z')]);
	await upload('bb', ['Private', 'Work'], []);
	expect(await search('passa')).toEqual(['Title a']);
	expect(await search('nothing')).toEqual([]);
	const names = async () => {
		const { sealed } = await route<{ sealed: Array<{ term: string; name: string }> }>('tags');
		return (await Promise.all(sealed.map(tag => openReadingTagName(tag, keys)))).sort();
	};
	expect(await names()).toEqual(['private', 'work']);
	const counted = await route<{ sealed: Array<{ term: string; name: string; count: number }> }>('tags?section=inbox');
	expect(await Promise.all(counted.sealed.map(async tag => [await openReadingTagName(tag, keys), tag.count]))).toEqual([['private', 2], ['work', 1]]);
	expect(JSON.stringify((await env.DB.prepare('SELECT * FROM reading_tags').all()).results)).not.toContain('private');
	await upload('bb', ['Private'], []);
	expect(await names()).toEqual(['private']);
	await upload('a', [], []);
	expect(await names()).toEqual(['private']);
	await upload('bb', [], []);
	expect(await names()).toEqual([]);
	expect(await search('passa')).toEqual([]);
});
