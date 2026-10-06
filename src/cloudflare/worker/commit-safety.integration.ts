/// <reference types="@cloudflare/vitest-plugin/types" />
import { commitStagedFile } from './sync-mutations';
import { commitNewFiles } from './bulk-new-file-commit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import schemaSql from '../schema.sql?raw';
import { handleUpload, handleDownload } from './sync-file-handlers';
import { handleBatchUpload } from './sync-batch/upload';
import { writeCommittedMarkdownFile } from './storage';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';
import { drainObjectCleanupQueue } from './maintenance/object-cleanup';
import { FILE_VERSION_RETENTION_MS, getStoredFileRow } from './sync-storage';
import { retainReplacedVersionStatement } from './file-publication-statements';

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
		const operationId = createReminderOperationId(Math.floor(Date.now() / 86400000));
		const request = () => new Request('https://test/sync/upload?path=note.md', {
			method: 'PUT', headers: { 'X-Crate-Upload-Operation': operationId, 'X-Crate-Expected-Hash': 'absent' }, body: 'only copy',
		});
		loseNextCommitResponse();
		expect((await handleUpload(request(), bucket, db, { commitUpload: commitStagedFile, commitNewFiles })).status).toBe(503);
		await expectLiveBytes();
		expect((await handleUpload(request(), bucket, db, { commitUpload: commitStagedFile, commitNewFiles })).status).toBe(200);
		await expectLiveBytes();
	});

	it('preserves committed batch uploads', async () => {
		loseNextCommitResponse();
		const response = await handleBatchUpload(new Request('https://test/sync/batch-upload', {
			method: 'POST', body: JSON.stringify({ files: [{ path: 'note.md', content: btoa('only copy'), operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)), expectedHash: null }] }),
		}), bucket, db, { commitUpload: commitStagedFile, commitNewFiles });
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

describe('publication history and derived state', () => {
	const sourcePath = 'Reminders/Inbox.md';
	const destinationPath = 'Reminders/Work.md';
	beforeEach(async () => {
		await db.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
		await writeCommittedMarkdownFile(bucket, db, sourcePath, '- [ ] Original source <!-- crate-id:source -->', null);
		await writeCommittedMarkdownFile(bucket, db, destinationPath, '- [ ] Original destination <!-- crate-id:destination -->', null);
	});

	async function publishedState() {
		const state: Record<string, unknown> = {};
		for (const table of ['files', 'file_versions', 'changelog', 'notification_projection_jobs', 'reminder_source_state', 'reminder_sources', 'reminder_occurrences']) {
			state[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
		}
		return state;
	}

	it.each(['single', 'pair'] as const)('retains replaced revisions and records only published %s file changes', async kind => {
		const source = (await getStoredFileRow(db, sourcePath))!;
		const destination = (await getStoredFileRow(db, destinationPath))!;
		const started = Date.now();
		const seq = (await db.prepare('SELECT MAX(seq) AS seq FROM changelog').first<{ seq: number }>())!.seq;
		if (kind === 'single') await writeCommittedMarkdownFile(bucket, db, sourcePath, 'Updated source', source.hash);
		else await writeCommittedMarkdownFilePair(bucket, db, {
			source: { path: sourcePath, content: 'Updated source', expectedHash: source.hash },
			destination: { path: destinationPath, content: 'Updated destination', expectedHash: destination.hash },
		});
		const previous = kind === 'single' ? [source] : [source, destination];
		const retained = (await db.prepare('SELECT storage_key, hash, size, reason, expires_at FROM file_versions').all<{
			storage_key: string; hash: string; size: number; reason: string; expires_at: number;
		}>()).results;
		expect(retained).toHaveLength(previous.length);
		for (const file of previous) {
			const version = retained.find(row => row.storage_key === file.storageKey)!;
			expect(version).toMatchObject({ hash: file.hash, size: file.size, reason: 'replaced' });
			expect(version.expires_at).toBeGreaterThanOrEqual(started + FILE_VERSION_RETENTION_MS);
			expect(await bucket.get(version.storage_key)).not.toBeNull();
		}
		const changes = (await db.prepare('SELECT path, revision FROM changelog WHERE seq > ? ORDER BY seq').bind(seq)
			.all<{ path: string; revision: string }>()).results;
		expect(changes.map(change => change.path)).toEqual(kind === 'single' ? [sourcePath] : [destinationPath, sourcePath]);
		for (const change of changes) expect(change.revision).toBe((await getStoredFileRow(db, change.path))?.storageKey);
	});

	it.each([
		['single', 'source'], ['pair', 'source'], ['pair', 'destination'],
	] as const)('leaves history and derived state unchanged when a %s publication rejects the %s precondition', async (kind, rejected) => {
		const source = (await getStoredFileRow(db, sourcePath))!;
		const destination = (await getStoredFileRow(db, destinationPath))!;
		const before = await publishedState();
		const staleHash = '0'.repeat(64);
		const write = kind === 'single'
			? writeCommittedMarkdownFile(bucket, db, sourcePath, 'Rejected change', staleHash)
			: writeCommittedMarkdownFilePair(bucket, db, {
				source: { path: sourcePath, content: 'Rejected source', expectedHash: rejected === 'source' ? staleHash : source.hash },
				destination: { path: destinationPath, content: 'Rejected destination', expectedHash: rejected === 'destination' ? staleHash : destination.hash },
			});
		await expect(write).rejects.toMatchObject({ name: 'FileVersionConflictError' });
		expect(await publishedState()).toEqual(before);
	});

	it.each([sourcePath, destinationPath])('requires every published move revision before retaining history (stale: %s)', async stalePath => {
		const source = (await getStoredFileRow(db, sourcePath))!;
		const destination = (await getStoredFileRow(db, destinationPath))!;
		await db.batch([retainReplacedVersionStatement(db, { ...source, path: sourcePath }, [
			{ path: sourcePath, objectKey: stalePath === sourcePath ? 'unpublished-source' : source.storageKey },
			{ path: destinationPath, objectKey: stalePath === destinationPath ? 'unpublished-destination' : destination.storageKey },
		])]);
		expect(await db.prepare('SELECT 1 FROM file_versions').first()).toBeNull();
	});
});
