/// <reference types="@cloudflare/vitest-plugin/types" />
import { commitStagedFile } from './mutations';
import { commitNewFiles } from './staging/bulk-new-file-commit';
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../../schema.sql?raw';
import { applySchema } from '../test-support/schema-test-harness';
import { handleBatchUpload } from './batch/upload';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { meterD1Writes } from '../test-support/d1-write-meter-test-harness';
import { drainNotificationProjections } from '../notifications/projection';
import { coordinatedNewFiles } from './staging/bulk-upload-dispatch';
import type { BatchUploadResponse } from '@/protocol/sync-types';

afterEach(async () => { await reset(); });
/** `compact` also builds `file_versions` and `reading_items` the WITHOUT ROWID way, as
 * `files` always is. New uploads write neither, so the writes are the same. */
async function initialize(compact = false) {
	for (let sql of schema.split(';').map(value => value.trim()).filter(Boolean)) {
		if (compact && /CREATE TABLE IF NOT EXISTS (file_versions|reading_items) \(/.test(sql)) {
			sql = sql.replace(/id INTEGER PRIMARY KEY,\s*/, '').replace(/(portable_path|storage_key) TEXT NOT NULL UNIQUE/, '$1 TEXT PRIMARY KEY') + ' WITHOUT ROWID';
		}
		await env.DB.prepare(sql).run();
	}
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Notes', 'UTC', 'policy')").run();
}
const file = (path: string, content = '# Ordinary note') => ({ path, content: btoa(content), expectedHash: null,
	operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) });
const request = (files: ReturnType<typeof file>[]) => new Request('https://test/sync/batch-upload', {
	method: 'POST', body: JSON.stringify({ files, bulkNewFiles: true }),
});

it.each([false, true])('bounds initial-upload writes and preserves retries (WITHOUT ROWID large tables: %s)', async compact => {
	await initialize(compact);
	// Reapplying the schema must preserve an existing database's table layout.
	await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('existing', 'existing', 'existing-key')").run();
	await applySchema(env.DB);
	expect(await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'existing'").first()).toEqual({ storage_key: 'existing-key' });
	for (const name of ['files', 'file_versions', 'reading_items']) {
		const table = await env.DB.prepare('SELECT sql FROM sqlite_master WHERE name = ?').bind(name).first<{ sql: string }>();
		expect(table!.sql.includes('WITHOUT ROWID'), name).toBe(compact || name === 'files');
	}

	const meter = meterD1Writes(env.DB);
	const files = Array.from({ length: 8 }, (_, i) => file(`Notes/${i}.md`));
	const result = await (await handleBatchUpload(request(files), env.BUCKET, meter.db, { commitUpload: commitStagedFile, commitNewFiles })).json() as BatchUploadResponse;
	expect(result.success).toBe(true);
	await drainNotificationProjections({ ...env, DB: meter.db }, 8);
	// Each new file writes its one `files` row.
	expect(meter.writes()).toBe(42);
	expect(await env.DB.prepare('SELECT path FROM notification_projection_jobs').first()).toBeNull();
	const beforeRetry = meter.writes();
	const retry = await (await handleBatchUpload(request(files), env.BUCKET, meter.db, { commitUpload: commitStagedFile, commitNewFiles })).json() as BatchUploadResponse;
	expect(retry).toEqual(result);
	expect(meter.writes() - beforeRetry).toBe(0);
});

it.each([false, true])('keeps cleanup work when a new upload replaces stale reminder state (delivered: %s)', async delivered => {
	await initialize();
	await env.DB.prepare(`INSERT INTO reminder_projections(reminder_id, file_path, notification_token, due_datetime, content, due_at, delivered_due)
    VALUES ('old-reminder', 'Notes/recreated.md', 'old-token', '2099-01-01T00:00:00.000Z', 'Old', 4070908800000, ?)`).bind(delivered ? new Date().toISOString() : null).run();
	const result = await (await handleBatchUpload(request([file('Notes/recreated.md')]), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles })).json() as BatchUploadResponse;
	expect(result.success).toBe(true);
	expect(await env.DB.prepare('SELECT path FROM notification_projection_jobs').first()).toEqual({ path: 'Notes/recreated.md' });
	await drainNotificationProjections(env, 8);
	// The departed schedule is cancelled with its row; a recent delivery stays as a detached tombstone.
	expect(await env.DB.prepare('SELECT reminder_id, file_path, due_at FROM reminder_projections').first())
		.toEqual(delivered ? { reminder_id: 'old-reminder', file_path: null, due_at: null } : null);
});

it('passes batch leases through the real reminder coordinator and schedules actual reminders', async () => {
	await initialize();
	const id = '11111111-1111-4111-8111-111111111111';
	const files = [file('Notes/plain.md'), file('Notes/reminder.md', `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`)];
	const result = await (await handleBatchUpload(request(files), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles: coordinatedNewFiles(env) })).json() as BatchUploadResponse;
	expect(result.success).toBe(true);
	expect(await env.DB.prepare('SELECT id FROM upload_leases').first()).toBeNull();
	expect(await env.DB.prepare("SELECT path FROM notification_projection_jobs WHERE path = 'Notes/plain.md'").first()).toBeNull();
	await drainNotificationProjections(env, 8);
	expect(await env.DB.prepare('SELECT reminder_id FROM reminder_projections').first()).toEqual({ reminder_id: id });
	for (const resultFile of result.results) expect(await env.BUCKET.head(resultFile.revision!)).not.toBeNull();
});
