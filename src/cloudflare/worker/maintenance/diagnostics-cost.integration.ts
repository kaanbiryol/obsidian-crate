/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { meterD1Usage } from '../d1/d1-usage';
import { handleDiagnostics } from './diagnostics';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(reset);

it('counts the changelog from its bounds and reads reminder projections once', { timeout: 120_000 }, async () => {
	const files = 50_000, reminders = 10_000;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO files(path, portable_path, storage_key) SELECT 'n/' || x, 'n/' || x, 'key-' || x FROM n`).bind(files).run();
	// Pruning removed the oldest entries; the rest are contiguous.
	await env.DB.prepare(`INSERT INTO changelog(seq, path, action, revision) SELECT CAST(substr(path, 3) AS INTEGER) + 7, path, 'put', storage_key FROM files`).run();
	const overdue = new Date(Date.now() - 60_000).toISOString(), failed = new Date(Date.now() - 120_000).toISOString();
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO reminder_projections(reminder_id, file_path, due_datetime, due_at, attempts, delivery_failed_at)
    SELECT 'r' || x, 'Reminders/a.md', CASE WHEN x % 10 = 0 THEN ? END, CASE WHEN x % 10 = 0 THEN 1 END,
      CASE WHEN x % 100 = 0 THEN 2 ELSE 0 END, CASE WHEN x % 1000 = 0 THEN ? END FROM n`).bind(reminders, overdue, failed).run();
	const meter = meterD1Usage(env.DB);
	const body = await (await handleDiagnostics(meter.db)).json() as { counts: Record<string, number>; oldestNotificationFailureAt: string | null; oldestOverdueNotificationAt: string | null };
	expect(body.counts).toMatchObject({ files, changelog: files, scheduledReminders: 1000, pendingNotificationJobs: 100, failedNotificationDeliveries: 10 });
	expect(body.oldestNotificationFailureAt).toBe(failed);
	expect(body.oldestOverdueNotificationAt).toBe(overdue);
	console.info('/diagnostics rows read:', meter.usage.rowsRead);
	// One pass over `files` and one over `reminder_projections`. Before: a changelog scan
	// and three reminder_projections statements, 127,529 rows at 50k files and 10k reminders.
	expect(meter.usage.rowsRead).toBeLessThanOrEqual(files + reminders + 100);
});

it('reports an empty changelog as zero', async () => {
	const body = await (await handleDiagnostics(env.DB)).json() as { counts: { changelog: number } };
	expect(body.counts.changelog).toBe(0);
});
