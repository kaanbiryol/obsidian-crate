/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { writeCommittedMarkdownMove } from '../sync/atomic-markdown-move';
import { commitFileDelete } from '../sync/mutations';
import { getStoredFileRow } from '../sync/storage';
import { adoptReadingClip, createReadingNote, updateReadingNote } from '@/reading/core/notes';
import { patchReadingFrontmatter } from '@/reading/core/frontmatter';
import { ensureReadingIndex, readingIndexScope } from './library-index';
import { readStoredNote } from './common';
import { readingTags } from './queries';
import { meterD1Usage } from '../d1/d1-usage';

// `reading_tag_counts` is kept by each commit's difference. These steps compare it with counts
// taken from the rows themselves, the way the section tag list counted before.
const policy = { enabled: 0, folder_path: 'Reading', generation: 'g', revision: 'r' };
const SECTIONS = ['inbox', 'archived', 'favorites', 'highlights'] as const;

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare('INSERT INTO reading_policy(id, enabled, folder_path, generation, revision, index_scope) VALUES (1, ?, ?, ?, ?, ?)')
		.bind(policy.enabled, policy.folder_path, policy.generation, policy.revision, readingIndexScope(policy)).run();
});
afterEach(reset);

/** Counts from the rows: each listed note's tags in each section that lists it. */
async function countedFromRows() {
	const { results } = await env.DB.prepare('SELECT metadata_json, duplicate, status, favorite, highlighted_at FROM reading_items')
		.all<{ metadata_json: string | null; duplicate: number; status: string | null; favorite: number; highlighted_at: string | null }>();
	const counts: Record<string, Record<string, number>> = Object.fromEntries(SECTIONS.map(section => [section, {}]));
	for (const row of results) {
		if (!row.metadata_json || row.duplicate) continue;
		const listed = { inbox: row.status === 'inbox', archived: row.status === 'archived', favorites: row.favorite === 1, highlights: row.highlighted_at !== null && row.status !== null };
		for (const tag of (JSON.parse(row.metadata_json) as { tags: string[] }).tags) {
			for (const section of SECTIONS) if (listed[section]) counts[section]![tag] = (counts[section]![tag] ?? 0) + 1;
		}
	}
	return counts;
}
async function stored() {
	const counts: Record<string, Record<string, number>> = {};
	for (const section of SECTIONS) {
		const { tags, counts: values } = await readingTags(env, false, section) as { tags: string[]; counts: number[] };
		counts[section] = Object.fromEntries(tags.map((tag, index) => [tag, values[index]!]));
	}
	return counts;
}
const expectCounts = async () => expect(await stored()).toEqual(await countedFromRows());

async function write(path: string, content: string) {
	const current = await getStoredFileRow(env.DB, path);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, current?.hash ?? null);
	return content;
}
async function remove(path: string) {
	const file = (await getStoredFileRow(env.DB, path))!;
	await commitFileDelete(env.DB, { path, previousFile: file, expectedHash: file.hash, expectedRevision: file.storageKey });
}

it('keeps every section\'s tag counts equal to its listed notes through edits, duplicates, moves, deletes and rebuilds', async () => {
	const note = (id: string, title: string, tags: string[]) => patchReadingFrontmatter(createReadingNote({ id, url: `https://example.invalid/${id}`, title, savedAt: new Date().toISOString() }), { tags });
	const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
	let noteA = await write('Reading/A.md', note(a, 'First', ['garden', 'tools']));
	const noteB = await write('Reading/B.md', note(b, 'Second', ['garden']));
	const noteC = await write('Reading/C.md', note(c, 'Third', ['solo']));
	await expectCounts();
	expect((await stored()).inbox).toEqual({ garden: 2, tools: 1, solo: 1 });

	noteA = await write('Reading/A.md', updateReadingNote(noteA, a, { favorite: true }));
	await write('Reading/B.md', updateReadingNote(noteB, b, { reading_status: 'archived' }));
	await expectCounts();
	noteA = await write('Reading/A.md', updateReadingNote(noteA, a, { tags: ['tools', 'later'] }));
	await expectCounts();

	// A highlighted clip lists in Highlights too.
	const clip = await adoptReadingClip('---\ntags: [quotes]\n---\nRead ==this passage==.', 'Reading/Clip.md', '2026-09-26T00:00:00Z');
	await write('Reading/Clip.md', clip);
	await expectCounts();
	expect((await stored()).highlights).toMatchObject({ quotes: 1 });

	// A second note with C's Reading ID makes both duplicates, which no list shows.
	await write('Reading/Copy.md', noteC);
	await expectCounts();
	expect((await stored()).inbox).not.toHaveProperty('solo');
	await remove('Reading/Copy.md');
	await expectCounts();
	expect((await stored()).inbox).toHaveProperty('solo', 1);

	const fileA = (await getStoredFileRow(env.DB, 'Reading/A.md'))!;
	await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: { path: 'Reading/A.md', expectedHash: fileA.hash, expectedRevision: fileA.storageKey }, destination: { path: 'Reading/Sub/A.md', content: noteA } });
	await remove('Reading/B.md');
	await expectCounts();

	// A rebuild in a new index format removes every row and indexes the notes again.
	await env.DB.prepare("UPDATE reading_policy SET index_scope = folder_path || char(10) || generation || char(10) || '0', index_cursor = NULL").run();
	while ((await ensureReadingIndex(env, policy, file => readStoredNote(env, file))).state !== 'complete');
	await expectCounts();
	expect(await stored()).toEqual({ inbox: { quotes: 1, solo: 1, later: 1, tools: 1 }, archived: {}, favorites: { later: 1, tools: 1 }, highlights: { quotes: 1 } });
});

it('ends a duplicate when its copy takes another ID, and an unrelated edit reads no flagged rows', async () => {
	const note = (id: string, title: string, tags: string[]) => patchReadingFrontmatter(createReadingNote({ id, url: `https://example.invalid/${id}`, title, savedAt: new Date().toISOString() }), { tags });
	const shared = crypto.randomUUID(), other = crypto.randomUUID();
	const original = await write('Reading/A.md', note(shared, 'First', ['garden']));
	await write('Reading/Copy.md', original);
	// Many flagged copies elsewhere in the library.
	const flagged = crypto.randomUUID(), copy = note(flagged, 'Copied', ['many']);
	for (let index = 0; index < 40; index++) await write(`Reading/Copies/${index}.md`, copy);
	expect((await env.DB.prepare('SELECT count(*) AS n FROM reading_items WHERE duplicate = 1').first<{ n: number }>())!.n).toBe(42);
	await expectCounts();

	// Before: every commit recounted every flagged row, here 42 and their groups.
	const lone = await write('Reading/Lone.md', note(other, 'Lone', ['solo']));
	const read = async (flaggedCopies: number) => {
		const meter = meterD1Usage(env.DB), current = (await getStoredFileRow(env.DB, 'Reading/Lone.md'))!;
		const content = updateReadingNote(lone, other, { favorite: flaggedCopies % 2 === 0 });
		await writeCommittedMarkdownFile(env.BUCKET, meter.db, 'Reading/Lone.md', content, current.hash);
		return meter.usage.rowsRead;
	};
	const withFlagged = await read(40);
	for (let index = 1; index < 40; index++) await remove(`Reading/Copies/${index}.md`);
	expect(Math.abs(await read(1) - withFlagged)).toBeLessThan(10);
	await expectCounts();

	await write('Reading/Copy.md', note(crypto.randomUUID(), 'Renamed copy', ['garden']));
	const rows = await env.DB.prepare('SELECT portable_path, duplicate FROM reading_items WHERE portable_path IN (?, ?)').bind('reading/a.md', 'reading/copy.md').all<{ portable_path: string; duplicate: number }>();
	expect(rows.results.map(row => row.duplicate)).toEqual([0, 0]);
	expect((await stored()).inbox).toMatchObject({ garden: 2 });
	await expectCounts();
	expect((await env.DB.prepare('SELECT duplicate FROM reading_items WHERE portable_path = ?').bind('reading/copies/0.md').first<{ duplicate: number }>())!.duplicate).toBe(0);
});
