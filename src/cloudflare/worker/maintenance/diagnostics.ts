import { corsResponse } from '../http/cors';
import { PUSH_RECIPIENT_AUTHORITY } from '../notifications/recipient-authority';
import { REMINDER_CACHE_PARSER_VERSION } from '../reminders/cache/types';

const LEASE_CLEANUP_PAUSED = 'Object cleanup could not be confirmed; the upload record is retained';

function firstCount(result: unknown): number {
	if (!result || typeof result !== 'object') return 0;
	const rows = (result as { results?: Array<{ count?: number }> }).results;
	return rows?.[0]?.count ?? 0;
}

interface ProjectionHealth {
	pendingDeliveries: number; scheduled: number; failed: number;
	oldestFailureAt: string | null; oldestOverdueAt: string | null;
}

/** Counts read bounds where they can: the retained changelog sequences are contiguous
 * (see `LAST_SEQ_SQL`), so two primary-key ends give its size. `reminder_projections`
 * is read in one pass for every delivery figure. */
export async function handleDiagnostics(db: D1Database): Promise<Response> {
	const results = await db.batch([
		db.prepare('SELECT COUNT(*) AS count FROM files'),
		// Separate subqueries: one statement with both MIN and MAX scans the table.
		db.prepare('SELECT COALESCE((SELECT MAX(seq) FROM changelog) - (SELECT MIN(seq) FROM changelog) + 1, 0) AS count'),
		db.prepare('SELECT COUNT(*) AS count FROM file_versions'),
		db.prepare('SELECT COUNT(*) AS count FROM object_cleanup_queue'),
		db.prepare(`SELECT COALESCE(SUM(due_at IS NOT NULL AND attempts > 0), 0) AS pendingDeliveries,
			COALESCE(SUM(due_at IS NOT NULL), 0) AS scheduled, COALESCE(SUM(delivery_failed_at IS NOT NULL), 0) AS failed,
			MIN(delivery_failed_at) AS oldestFailureAt,
			MIN(CASE WHEN due_at IS NOT NULL AND due_datetime < ? THEN due_datetime END) AS oldestOverdueAt FROM reminder_projections`)
			.bind(new Date().toISOString()),
		db.prepare('SELECT COUNT(*) AS count FROM auth_tokens WHERE expires_at IS NULL OR expires_at > ?').bind(Date.now()),
		db.prepare(`SELECT COUNT(*) AS count FROM push_subscriptions WHERE ${PUSH_RECIPIENT_AUTHORITY}`).bind(Date.now()),
		db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE disabled_at IS NOT NULL'),
		db.prepare('SELECT COUNT(*) AS count FROM notification_projection_jobs'),
		db.prepare('SELECT COUNT(*) AS count FROM notification_projection_jobs WHERE last_error IS NOT NULL'),
		db.prepare("SELECT COUNT(*) AS count FROM operations WHERE kind = 'reminder'"),
		db.prepare('SELECT COUNT(*) AS count FROM reminder_source_state WHERE parser_version < ?').bind(REMINDER_CACHE_PARSER_VERSION),
		db.prepare('SELECT COUNT(*) AS count FROM reminder_source_state WHERE parser_version = ? AND verified = 0').bind(REMINDER_CACHE_PARSER_VERSION),
	]);
	const deliveryHealth = (results[4] as { results?: ProjectionHealth[] }).results?.[0];
	const [lastRun, lastError, projectionIssues, pausedFiles, pausedLeases] = await Promise.all([
		db.prepare("SELECT value FROM maintenance_state WHERE key = 'last_run'").first<{ value: string }>(),
		db.prepare("SELECT value FROM maintenance_state WHERE key = 'last_error'").first<{ value: string }>(),
		db.prepare(`SELECT path, last_error AS reason FROM notification_projection_jobs
			WHERE last_error IS NOT NULL ORDER BY updated_at, path LIMIT 100`).all<{ path: string; reason: string }>(),
	db.prepare('SELECT path, attempts, error FROM notification_file_retries WHERE (attempts >= 8 OR available_at < 0) ORDER BY path LIMIT 100').all(),
	// Cleanup stops retrying a record (clears its expiry) only after it could not confirm the object.
	db.prepare(`SELECT json_extract(k.value, '$.storageKey') AS storageKey, '${LEASE_CLEANUP_PAUSED}' AS error
      FROM upload_leases l, json_each(l.keys) k WHERE l.expires_at IS NULL ORDER BY storageKey LIMIT 100`).all(),
	]);
	return corsResponse({
		status: 'ok',
	pausedNotificationFiles: pausedFiles.results,
	pausedUploadCleanup: pausedLeases.results,
		counts: {
			files: firstCount(results[0]),
			changelog: firstCount(results[1]),
			retainedVersions: firstCount(results[2]),
			pendingObjectCleanup: firstCount(results[3]),
			// Deliveries waiting for a retry.
			pendingNotificationJobs: deliveryHealth?.pendingDeliveries ?? 0,
			scheduledReminders: deliveryHealth?.scheduled ?? 0,
			activeAuthTokens: firstCount(results[5]),
			activePushSubscriptions: firstCount(results[6]),
			disabledPushSubscriptions: firstCount(results[7]),
			pendingNotificationProjections: firstCount(results[8]),
			failedNotificationProjections: firstCount(results[9]),
			reminderOperationReceipts: firstCount(results[10]),
			failedNotificationDeliveries: deliveryHealth?.failed ?? 0,
			pendingReminderSourceVerification: firstCount(results[11]),
			quarantinedReminderSources: firstCount(results[12]),
		},
		lastMaintenanceAt: lastRun?.value ?? null,
		lastMaintenanceError: lastError?.value ?? null,
		oldestNotificationFailureAt: deliveryHealth?.oldestFailureAt ?? null,
		oldestOverdueNotificationAt: deliveryHealth?.oldestOverdueAt ?? null,
		notificationProjectionIssues: projectionIssues.results,
		reminderSourceParserVersion: REMINDER_CACHE_PARSER_VERSION,
	});
}
