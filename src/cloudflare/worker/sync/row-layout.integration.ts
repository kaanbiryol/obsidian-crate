/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import { sealFile } from '../../../encryption/file-codec';
import { meterD1Writes } from '../test-support/d1-write-meter-test-harness';
import { commitStagedFile, commitStagedFiles } from './mutations';
import { commitNewFiles } from './staging/bulk-new-file-commit';
import { handleUpload } from './file-handlers';
import { handleBatchUpload } from './batch/upload';
import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { FILE_VERSION_CUTOFF_SQL } from './storage';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { sha256Hex } from '@/platform/sha256';
import { descriptorColumn } from '../encryption/state';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO server_state(id, import_token, import_state) VALUES(1, 'established', 'complete') ON CONFLICT(id) DO UPDATE SET import_token = excluded.import_token, import_state = excluded.import_state").run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

const size = async () => ((await env.DB.prepare('SELECT 1').run()) as { meta: { size_after: number } }).meta.size_after;
// Three folders deep with 26-character tags, and today's object keys.
const TAG = 'lower(hex(randomblob(13)))';
const KEY = `'__crate__/files/' || lower(hex(randomblob(32))) || '/' || lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-'
  || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))`;
const plan = async (sql: string, ...args: unknown[]) => JSON.stringify((await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all()).results);

it('keeps an encrypted file row with its packed descriptor within its page', { timeout: 120_000 }, async () => {
	const { keys } = await createEncryptionFixture('active');
	const path = 'Projects/Work/Meeting notes 2026.md';
	const sealed = await sealFile({ path, content: new TextEncoder().encode('# sample') }, keys.forPath(path));
	const descriptor = descriptorColumn(sealed.descriptor)!;
	const rows = 10_000;
	const before = await size();
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?), p AS (SELECT ${TAG} || '/' || ${TAG} || '/' || ${TAG} || '.md' AS path FROM n)
    INSERT INTO files(path, portable_path, hash, size, storage_key, descriptor) SELECT path, path, lower(hex(randomblob(32))), 2600, ${KEY}, ? FROM p`).bind(rows, descriptor).run();
	const bytes = Math.round((await size() - before) / rows);
	console.info('Encrypted files row bytes:', bytes, 'descriptor bytes:', descriptor.length);
	// `files` is WITHOUT ROWID for one write per new file. A row over about 1 KB takes an
	// overflow page of its own, as the descriptor's JSON did at 4,691 B; packed, it fits.
	expect(bytes).toBeLessThan(1_500);
});

it('serves hot lookups from primary and unique keys', async () => {
	expect(await plan(`SELECT hash, size, storage_key FROM files WHERE ${FILE_PATH_MATCH}`, ...filePathArgs('Notes/a.md')))
		.toContain('USING PRIMARY KEY (portable_path=?)');
	expect(await plan('SELECT path, hash, size, storage_key FROM files WHERE portable_path > ? ORDER BY portable_path LIMIT 5000', ''))
		.toContain('USING PRIMARY KEY (portable_path>?)');
	expect(await plan('SELECT path FROM file_versions WHERE storage_key = ?', 'key')).toContain('USING INDEX sqlite_autoindex_file_versions_1 (storage_key=?)');
	expect(await plan('SELECT card FROM reading_items WHERE portable_path = ?', 'reading/a.md')).toContain('USING INDEX sqlite_autoindex_reading_items_1 (portable_path=?)');
	// The unfiltered version list pages by kept time and row ID through its index, so a page
	// sorts nothing even when many versions were kept at once.
	const versions = await plan(`SELECT id, storage_key, path, hash, size, reason, created_at, kept_at, descriptor FROM file_versions
    WHERE kept_at > ${FILE_VERSION_CUTOFF_SQL} AND (kept_at, id) < (?, ?) ORDER BY kept_at DESC, id DESC LIMIT 101`, 0, 9, 5);
	expect(versions).toContain('USING INDEX file_versions_kept_at_idx');
	expect(versions).not.toContain('TEMP B-TREE');
	const byPath = await plan(`SELECT storage_key FROM file_versions WHERE kept_at > ${FILE_VERSION_CUTOFF_SQL} AND path = ? ORDER BY created_at DESC, storage_key DESC LIMIT 101`, 0, 'a.md');
	expect(byPath).toContain('file_versions_path_created_key_idx');
	expect(byPath).not.toContain('TEMP B-TREE');
});

it('writes one lease row per request and no unchanged key on update', async () => {
	const day = Math.floor(Date.now() / 86400000);
	const put = async (path: string, content: string, expectedHash: string | null) => {
		const meter = meterD1Writes(env.DB);
		const response = await handleUpload(new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: content,
			headers: { 'X-Crate-Upload-Operation': createReminderOperationId(day), 'X-Crate-Expected-Hash': expectedHash ?? 'absent', 'Content-Type': 'text/markdown' } }),
		env.BUCKET, meter.db, { commitUpload: commitStagedFile, commitNewFiles });
		expect(response.status).toBe(200);
		return meter.writes();
	};
	// A lease insert and delete, the files row, changelog, receipt and the file count.
	expect(await put('Journal/a.md', '# A', null)).toBe(6);
	// The first commit with a file saves a checkpoint row, which keeps the replaced copy: its row
	// and three index entries. The update writes the files row only.
	expect(await put('Journal/a.md', '# A2', await sha256Hex('# A'))).toBe(10);

	const files = await Promise.all(Array.from({ length: 32 }, async (_, i) => ({ path: `Bulk/${i}.md`, content: btoa(`# ${i}`), expectedHash: null as string | null,
		operationId: createReminderOperationId(day), contentType: 'text/markdown', hash: await sha256Hex(`# ${i}`) })));
	const batch = async (body: unknown) => {
		const meter = meterD1Writes(env.DB);
		const response = await handleBatchUpload(new Request('https://test/sync/batch-upload', { method: 'POST', body: JSON.stringify(body) }),
			env.BUCKET, meter.db, { commitUpload: commitStagedFile, commitUploads: commitStagedFiles, commitNewFiles });
		expect((await response.json() as { success: boolean }).success).toBe(true);
		return meter.writes();
	};
	// Bulk: one lease, rows, one changelog insert, receipts and the file count.
	expect(await batch({ files, bulkNewFiles: true })).toBe(3 + 32 * 3);
	await env.DB.prepare('UPDATE history_checkpoints SET created_at = created_at - 660000').run();
	const updates = files.map((file, i) => ({ ...file, content: btoa(`# ${i} edited`), hash: undefined, expectedHash: file.hash, operationId: createReminderOperationId(day) }));
	// Before: 9 per file, two of them the file's own lease. Ten minutes on, the batch saves a checkpoint row.
	expect(await batch({ files: updates })).toBe(3 + 32 * 7);
});
