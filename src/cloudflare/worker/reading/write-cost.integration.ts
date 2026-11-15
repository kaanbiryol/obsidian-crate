/// <reference types="@cloudflare/vitest-plugin/types" />
import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { createReadingNote } from '@/reading/core/notes';
import { patchReadingFrontmatter, readReadingFrontmatter } from '@/reading/core/frontmatter';
import { readingDocument } from '@/reading/core/markdown';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readingIndexScope } from './library-index';
import { mutateReading } from './mutations';
import { meterD1Usage } from '../d1/d1-usage';

const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };
// Every web app edit is a synced file edit: a version, changelog, receipt and staging rows
// stay. Only the Reading index part changes, so these bounds catch index churn.
it('keeps the rows a web app favorite or archive writes to the file edit and its index row', { timeout: 120_000 }, async context => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('vault', 'hash', 'vault')").run();
	await env.DB.prepare('INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, ?, ?, ?, ?)').bind(policy.enabled, policy.folder_path, policy.generation, policy.revision).run();
	await env.DB.prepare("UPDATE reading_policy SET index_scope = ? WHERE id = 1").bind(readingIndexScope(policy)).run();
	const id = crypto.randomUUID();
	// An extracted article, as most saved notes are.
	const note = patchReadingFrontmatter(createReadingNote({ id, url: 'https://example.invalid/target', title: 'Target', savedAt: new Date().toISOString() }), { tags: ['research'], extraction_status: 'ready' });
	const content = note.replace('<!-- crate:article:start -->\n', '<!-- crate:article:start -->\nArticle text.\n');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Target.md', content, null);
	// The highlights the last edit saved, which the next edit names as its starting point.
	let saved: unknown;
	const measure = async (changes: Record<string, unknown>, before: Record<string, unknown>) => {
		const meter = meterD1Usage(env.DB);
		const response = await mutateReading({ ...env, DB: meter.db }, { tokenId: 'vault', scope: 'vault' }, policy,
			{ id, before, changes, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)) }, 'update');
		expect(response.status, await response.clone().text()).toBe(200);
		saved = ((await response.json()) as { article: { item: { highlights?: unknown } } }).article.item.highlights;
		return { written: meter.usage.rowsWritten, read: meter.usage.rowsRead };
	};
	const favorite = await measure({ favorite: true }, { favorite: false });
	const archive = await measure({ reading_status: 'archived' }, { reading_status: 'inbox' });
	// Before: every index on the row was rewritten, 22 and 19 rows. A favorite or archive now also
	// moves the note between section indexes (two rows); its search terms are unchanged.
	expect(favorite.written).toBeLessThanOrEqual(20);
	expect(archive.written).toBeLessThanOrEqual(17);
	// A first highlight adds the note's highlight_index row; a later one moves it to its new
	// date (a delete and an insert), and a highlight note only rewrites its terms.
	const start = readingDocument(readReadingFrontmatter(content)!.body).text.indexOf('Article');
	const passage = (createdAt: string, note?: string) => ({ start, end: start + 7, text: 'Article', createdAt, ...note ? { note } : {} });
	const firstHighlight = await measure({ highlights: [passage('2026-02-01T00:00:00.000Z')] }, {});
	const newerHighlight = await measure({ highlights: [passage('2026-02-02T00:00:00.000Z')] }, { highlights: saved });
	const highlightNote = await measure({ highlights: [passage('2026-02-02T00:00:00.000Z', 'Revisit')] }, { highlights: saved });
	// Measured 8, 9 and 8; the same edits wrote 7 rows before highlight_index.
	expect(firstHighlight.written).toBeLessThanOrEqual(9);
	expect(newerHighlight.written).toBeLessThanOrEqual(10);
	expect(highlightNote.written).toBeLessThanOrEqual(9);
	await context.annotate(JSON.stringify({ favorite, archive, firstHighlight, newerHighlight, highlightNote }), 'writes');
});

it('reads about the same rows for a web app edit however many notes are highlighted', { timeout: 120_000 }, async () => {
	// Runs after the test above, in the same database, with its token and policy.
	const id = crypto.randomUUID();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Second.md', createReadingNote({ id, url: 'https://example.invalid/second', title: 'Second', savedAt: new Date().toISOString() }), null);
	// Other highlighted notes' rows, which an edit to this note must not read.
	await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
    INSERT INTO highlight_index(highlighted_at, portable_path, terms, words) SELECT printf('2026-01-01T00:00:%04dZ', i), printf('reading/other-%d.md', i), '[]', NULL FROM n`).run();
	const meter = meterD1Usage(env.DB);
	const response = await mutateReading({ ...env, DB: meter.db }, { tokenId: 'vault', scope: 'vault' }, policy,
		{ id, before: { favorite: false }, changes: { favorite: true }, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)) }, 'update');
	expect(response.status, await response.clone().text()).toBe(200);
	// Before: the highlight_index delete scanned the whole table, about 2,100 rows here.
	expect(meter.usage.rowsRead).toBeLessThan(400);
});
