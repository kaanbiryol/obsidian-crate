/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { parseD1Usage, D1_USAGE_HEADER } from '@/protocol/d1-usage';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { sha256Hex } from '@/platform/sha256';
import { createReadingNote, updateReadingNote } from '@/reading/core/notes';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { writeCommittedMarkdownMove } from '../sync/atomic-markdown-move';
import { commitFileDelete } from '../sync/mutations';
import { getStoredFileRow } from '../sync/storage';
import { readingIndexScope } from './library-index';

const policy = { enabled: 0, folder_path: 'Reading', generation: 'g', revision: 'r' };
interface Changes { revision: string; reset?: true; items?: Array<{ crate_reading_id: string; path: string; favorite: boolean }>; issues?: Array<{ path: string }>; removed?: string[] }

async function request<T>(path: string) {
	const response = await worker.fetch(new Request(`https://crate.test/reading/${path}`, {
		headers: { Authorization: 'Bearer vault-credential', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) },
	}), env);
	const text = await response.text();
	expect(response.status, text).toBe(200);
	return { body: JSON.parse(text) as T, rowsRead: parseD1Usage(response.headers.get(D1_USAGE_HEADER))!.rowsRead };
}
const revision = async () => (await request<{ revision: string }>('items?section=inbox')).body.revision;
const changes = (since: string) => request<Changes>(`changes?since=${encodeURIComponent(since)}`);
async function write(path: string, content: string) {
	const current = await getStoredFileRow(env.DB, path);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, current?.hash ?? null);
}

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('vault', ?, 'vault')").bind(await sha256Hex('vault-credential')).run();
	await env.DB.prepare('INSERT INTO reading_policy(id, enabled, folder_path, generation, revision, index_scope) VALUES (1, ?, ?, ?, ?, ?)')
		.bind(policy.enabled, policy.folder_path, policy.generation, policy.revision, readingIndexScope(policy)).run();
});
afterEach(reset);

it('answers what changed since a revision: edited, moved, deleted and duplicate notes', async () => {
	const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
	const note = (id: string, title: string) => createReadingNote({ id, url: `https://example.invalid/${id}`, title, savedAt: new Date().toISOString() });
	const noteA = note(a, 'First'), noteC = note(c, 'Third');
	await write('Reading/A.md', noteA); await write('Reading/B.md', note(b, 'Second')); await write('Reading/C.md', noteC);
	const first = await revision();

	// Nothing changed: the index row the request reads anyway answers it.
	const unchanged = await changes(first);
	expect(unchanged.body).toEqual({ revision: first, items: [], issues: [], removed: [] });
	expect(unchanged.rowsRead).toBeLessThan(10);

	await write('Reading/A.md', updateReadingNote(noteA, a, { favorite: true }));
	const edited = await changes(first);
	expect(edited.body.items).toEqual([expect.objectContaining({ crate_reading_id: a, favorite: true, path: 'Reading/A.md' })]);
	expect(edited.body.removed).toEqual([]);
	expect(edited.body.revision).not.toBe(first);

	const fileB = (await getStoredFileRow(env.DB, 'Reading/B.md'))!;
	await commitFileDelete(env.DB, { path: 'Reading/B.md', previousFile: fileB, expectedHash: fileB.hash, expectedRevision: fileB.storageKey });
	const fileA = (await getStoredFileRow(env.DB, 'Reading/A.md'))!;
	await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: { path: 'Reading/A.md', expectedHash: fileA.hash, expectedRevision: fileA.storageKey },
		destination: { path: 'Reading/Later/A.md', content: (await env.BUCKET.get(fileA.storageKey).then(object => object!.text())) } });
	const later = await changes(edited.body.revision);
	expect(later.body.items!.map(item => item.path)).toEqual(['Reading/Later/A.md']);
	expect(later.body.removed!.sort()).toEqual(['Reading/A.md', 'Reading/B.md']);

	// A copy with C's Reading ID hides both notes and lists them as issues.
	const before = later.body.revision;
	await write('Reading/Copy.md', noteC);
	const copied = await changes(before);
	expect(copied.body.items).toEqual([]);
	expect(copied.body.removed!.sort()).toEqual(['Reading/C.md', 'Reading/Copy.md']);
	expect(copied.body.issues!.map(issue => issue.path).sort()).toEqual(['Reading/C.md', 'Reading/Copy.md']);
	expect(copied.rowsRead).toBeLessThan(40);
});

it('answers reset for another epoch, an unknown revision or too many changes', async () => {
	await write('Reading/A.md', createReadingNote({ id: crypto.randomUUID(), url: 'https://example.invalid/a', savedAt: new Date().toISOString() }));
	const first = await revision();
	expect((await changes('not a revision')).body).toMatchObject({ reset: true });
	// A rebuild that changes rows starts an epoch: the changelog does not list them. One that
	// finds every row current keeps the revision.
	await env.DB.prepare('UPDATE reading_policy SET index_scope = NULL, index_cursor = NULL').run();
	expect(await revision()).toBe(first);
	await env.DB.batch([env.DB.prepare('DELETE FROM reading_items'), env.DB.prepare('UPDATE reading_policy SET index_scope = NULL, index_cursor = NULL')]);
	const rebuilt = await revision();
	expect(rebuilt).not.toBe(first);
	expect((await changes(first)).body).toEqual({ revision: rebuilt, reset: true });
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 501)
    INSERT INTO changelog(seq, path, action, hash, size) SELECT 1000 + x, 'Notes/' || x || '.md', 'put', '', 0 FROM n`).run();
	await env.DB.prepare('UPDATE reading_policy SET changed = 2000').run();
	expect((await changes(rebuilt)).body).toMatchObject({ reset: true });
});
