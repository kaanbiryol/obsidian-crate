/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { handleUpload, handleDownload } from './sync-file-handlers';
import { handleBatchUpload } from './sync-batch/upload';
import { writeCommittedMarkdownFile } from './storage';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';
import { drainObjectCleanupQueue } from './sync-storage';

const { DB: db, BUCKET: bucket } = env;
beforeEach(async () => {
	for (const sql of schemaSql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(sql).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function loseNextCommitResponse() {
	const batch = db.batch.bind(db);
	vi.spyOn(db, 'batch').mockImplementationOnce(async statements => {
		await batch(statements);
		throw new Error('Commit response lost');
	});
}

async function expectLiveBytes() {
	const rows = await db.prepare('SELECT path, storage_key FROM files').all<{ path: string; storage_key: string }>();
	expect(rows.results.length).toBeGreaterThan(0);
	for (const row of rows.results) {
		expect(await bucket.get(row.storage_key)).not.toBeNull();
		expect((await handleDownload(new Request(`https://test/sync/download?path=${encodeURIComponent(row.path)}`), bucket, db)).status).toBe(200);
	}
}

describe('uncertain commits preserve live content', () => {
	it('preserves single-upload bytes through the failed response and identical retry', async () => {
		const request = () => new Request('https://test/sync/upload?path=note.md', {
			method: 'PUT', headers: { 'X-Crate-Expected-Hash': 'absent' }, body: 'only copy',
		});
		loseNextCommitResponse();
		expect((await handleUpload(request(), bucket, db)).status).toBe(503);
		await expectLiveBytes();
		expect((await handleUpload(request(), bucket, db)).status).toBe(200);
		await expectLiveBytes();
	});

	it('preserves committed batch uploads', async () => {
		loseNextCommitResponse();
		const response = await handleBatchUpload(new Request('https://test/sync/batch-upload', {
			method: 'POST', body: JSON.stringify({ files: [{ path: 'note.md', content: btoa('only copy'), expectedHash: null }] }),
		}), bucket, db);
		expect(response.status).toBe(503);
		await expectLiveBytes();
	});

	it('preserves committed reminder writes', async () => {
		loseNextCommitResponse();
		await expect(writeCommittedMarkdownFile(bucket, db, 'Reminders/Inbox.md', 'only copy', null)).rejects.toThrow('Commit response lost');
		await expectLiveBytes();
	});

	it('preserves both files in a committed reminder move', async () => {
		const source = await writeCommittedMarkdownFile(bucket, db, 'Reminders/Inbox.md', 'move me', null);
		loseNextCommitResponse();
		await expect(writeCommittedMarkdownFilePair(bucket, db, {
			source: { path: 'Reminders/Inbox.md', content: '# Inbox', expectedHash: source.hash },
			destination: { path: 'Reminders/Work.md', content: 'move me', expectedHash: null },
		})).rejects.toThrow('Commit response lost');
		await expectLiveBytes();
	});

	it('does not delete live or retained content accidentally queued for cleanup', async () => {
		const first = await writeCommittedMarkdownFile(bucket, db, 'note.md', 'first', null);
		await writeCommittedMarkdownFile(bucket, db, 'note.md', 'second', first.hash);
		const rows = await db.prepare('SELECT storage_key FROM files UNION SELECT storage_key FROM file_versions').all<{ storage_key: string }>();
		for (const row of rows.results) await db.prepare('INSERT INTO object_cleanup_queue (storage_key) VALUES (?)').bind(row.storage_key).run();
		await drainObjectCleanupQueue(bucket, db);
		for (const row of rows.results) expect(await bucket.get(row.storage_key)).not.toBeNull();
		expect((await db.prepare('SELECT COUNT(*) AS count FROM object_cleanup_queue').first<{ count: number }>())?.count).toBe(0);
	});
});
