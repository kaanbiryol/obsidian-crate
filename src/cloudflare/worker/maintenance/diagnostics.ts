import { corsResponse } from '../cors';
import { PUSH_RECIPIENT_AUTHORITY } from '../notifications/recipient-authority';

function firstCount(result: unknown): number {
	if (!result || typeof result !== 'object') return 0;
	const rows = (result as { results?: Array<{ count?: number }> }).results;
	return rows?.[0]?.count ?? 0;
}

export async function handleDiagnostics(db: D1Database): Promise<Response> {
	const results = await db.batch([
		db.prepare('SELECT COUNT(*) AS count FROM files'),
		db.prepare('SELECT COUNT(*) AS count FROM changelog'),
		db.prepare('SELECT COUNT(*) AS count FROM file_versions'),
		db.prepare('SELECT COUNT(*) AS count FROM object_cleanup_queue'),
		db.prepare('SELECT COUNT(*) AS count FROM notification_jobs'),
		db.prepare('SELECT COUNT(*) AS count FROM scheduled_reminders'),
		db.prepare('SELECT COUNT(*) AS count FROM auth_tokens WHERE expires_at IS NULL OR expires_at > ?').bind(Date.now()),
		db.prepare(`SELECT COUNT(*) AS count FROM push_subscriptions WHERE ${PUSH_RECIPIENT_AUTHORITY}`).bind(Date.now()),
		db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE disabled_at IS NOT NULL'),
		db.prepare('SELECT COUNT(*) AS count FROM notification_projection_jobs'),
		db.prepare('SELECT COUNT(*) AS count FROM notification_projection_jobs WHERE last_error IS NOT NULL'),
		db.prepare('SELECT COUNT(*) AS count FROM notification_jobs WHERE last_error IS NOT NULL'),
		db.prepare('SELECT COUNT(*) AS count FROM reminder_operations'),
		db.prepare('SELECT COUNT(*) AS count FROM scheduled_reminders WHERE delivery_failed_at IS NOT NULL'),
	]);
	const [lastRun, lastError, deliveryHealth, projectionIssues] = await Promise.all([
		db.prepare("SELECT value FROM maintenance_state WHERE key = 'last_run'").first<{ value: string }>(),
		db.prepare("SELECT value FROM maintenance_state WHERE key = 'last_error'").first<{ value: string }>(),
		db.prepare(`SELECT MIN(delivery_failed_at) AS oldestFailureAt,
			MIN(CASE WHEN due_datetime < ? THEN due_datetime END) AS oldestOverdueAt FROM scheduled_reminders`)
			.bind(new Date().toISOString()).first<{ oldestFailureAt: string | null; oldestOverdueAt: string | null }>(),
		db.prepare(`SELECT path, last_error AS reason FROM notification_projection_jobs
			WHERE last_error IS NOT NULL ORDER BY updated_at, path LIMIT 100`).all<{ path: string; reason: string }>(),
	]);
	return corsResponse({
		status: 'ok',
		counts: {
			files: firstCount(results[0]),
			changelog: firstCount(results[1]),
			retainedVersions: firstCount(results[2]),
			pendingObjectCleanup: firstCount(results[3]),
			pendingNotificationJobs: firstCount(results[4]),
			scheduledReminders: firstCount(results[5]),
			activeAuthTokens: firstCount(results[6]),
			activePushSubscriptions: firstCount(results[7]),
			disabledPushSubscriptions: firstCount(results[8]),
			pendingNotificationProjections: firstCount(results[9]),
			failedNotificationProjections: firstCount(results[10]),
			failedNotificationJobs: firstCount(results[11]),
			reminderOperationReceipts: firstCount(results[12]),
			failedNotificationDeliveries: firstCount(results[13]),
		},
		lastMaintenanceAt: lastRun?.value ?? null,
		lastMaintenanceError: lastError?.value ?? null,
		oldestNotificationFailureAt: deliveryHealth?.oldestFailureAt ?? null,
		oldestOverdueNotificationAt: deliveryHealth?.oldestOverdueAt ?? null,
		notificationProjectionIssues: projectionIssues.results,
	});
}
