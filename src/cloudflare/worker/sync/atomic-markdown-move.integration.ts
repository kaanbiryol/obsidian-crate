/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile, FileVersionConflictError } from '../storage';
import { writeCommittedMarkdownMove } from './atomic-markdown-move';
import { getStoredFileRow } from './storage';
import { FileNamespaceConflictError } from './file-namespace';

beforeEach(() => applySchema(env.DB));
afterEach(reset);

async function source(path = 'Reading/Old.md') {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, 'Before', null);
	const row = (await getStoredFileRow(env.DB, path))!;
	return { path, expectedHash: row.hash, expectedRevision: row.storageKey };
}
const files = async () => (await env.DB.prepare('SELECT path FROM files ORDER BY path').all<{ path: string }>()).results.map(row => row.path);

it('publishes the destination and deletes the exact source revision in one transaction', async () => {
	const from = await source();
	const moved = await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: from, destination: { path: 'Reading/New.md', content: 'After' } });
	expect(await files()).toEqual(['Reading/New.md']);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/New.md'))?.content).toBe('After');
	expect((await env.DB.prepare('SELECT path, action, revision FROM changelog ORDER BY seq DESC LIMIT 2').all()).results).toEqual([
		{ path: from.path, action: 'delete', revision: moved.deletion.revision }, { path: 'Reading/New.md', action: 'put', revision: moved.revision }]);
	expect(await env.DB.prepare('SELECT consumed_revision AS consumed FROM file_deletion_receipts WHERE path=?').bind(from.path).first()).toEqual({ consumed: from.expectedRevision });
	expect(await env.DB.prepare("SELECT path FROM file_versions WHERE reason='deleted'").first()).toEqual({ path: from.path });
	expect(await env.DB.prepare('SELECT 1 FROM staged_uploads').first()).toBeNull();
});

it('writes nothing when the source changed or the destination is taken', async () => {
	const from = await source();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, from.path, 'Edited elsewhere', from.expectedHash);
	await expect(writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: from, destination: { path: 'Reading/New.md', content: 'After' } }))
		.rejects.toBeInstanceOf(FileVersionConflictError);
	const current = (await getStoredFileRow(env.DB, from.path))!;
	const fresh = { path: from.path, expectedHash: current.hash, expectedRevision: current.storageKey };
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Taken.md', 'Keep me', null);
	await expect(writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: fresh, destination: { path: 'reading/taken.md', content: 'After' } }))
		.rejects.toBeInstanceOf(FileNamespaceConflictError);
	await expect(writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: fresh, destination: { path: 'Reading/Taken.md', content: 'After' } }))
		.rejects.toBeInstanceOf(FileVersionConflictError);
	await expect(writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: fresh, destination: { path: 'reading/old.md', content: 'After' } }))
		.rejects.toThrow('two distinct paths');
	expect(await files()).toEqual(['Reading/Old.md', 'Reading/Taken.md']);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/Taken.md'))?.content).toBe('Keep me');
	expect(await env.DB.prepare('SELECT 1 FROM file_deletion_receipts').first()).toBeNull();
	expect(await env.DB.prepare('SELECT 1 FROM staged_uploads').first()).toBeNull();
});
