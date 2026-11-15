import { parseStoredFeaturePolicy } from '../server/feature-policy';
import { scheduleReading } from '../reading/extraction/jobs';
import { NEXT_NOTIFICATION_WORK_SQL, NEXT_SOURCE_RETRY_SQL } from './queue';
import { NOTIFICATION_POLICY_COLUMNS, notificationPolicyFromRow, type NotificationPolicyRow } from './policy';
import type { Env } from '../types';
import { drainNotificationProjections } from './projection';
import { revalidateReminderSources, SCAN_KEY, type VerifiedSourceBytes } from '../reminders/source-migration';
import { REMINDER_CACHE_PARSER_VERSION } from '../reminders/cache/types';
import { completeReadingIndex } from '../reading/library-index';
import { ENCRYPTION_STATE_SQL, parseEncryptionState } from '../encryption/state';
import { serverStateValue } from '../d1/server-state';

type NotificationWork = { ready: number; projectionRetry: number | null; dispatchAt: number | null };

// Files each pass verifies and then projects, about two D1 queries each. The worst case,
// 38 queries with a Reading index page, stays within D1_QUERIES_PER_INVOCATION
// (coordinator-budget.integration.ts); per-pass source byte budgets bound memory and
// CPU for large and encrypted notes.
const FILES_PER_PASS = 8;

function nextNotificationWork(db: D1Database): Promise<NotificationWork | null> {
	return db.prepare(NEXT_NOTIFICATION_WORK_SQL).first<NotificationWork>();
}

/** What a pass means for the dispatcher: whether a commit wrote a schedule, and the
 * earliest due time, or undefined when the pass did not read it. The caller wakes the
 * dispatcher after releasing the coordinator lock; the alarm set here covers the next pass. */
export interface NotificationPassResult { wrote: boolean; dispatchAt: number | null | undefined }

/** Whether a pass has anything to do, read with the settings each step needs. Reminder work is
 * a ready job, a due retry, an unfinished source scan, an outdated source or a source record
 * outside the folder; Reading work is an unfinished index, a capture, a job or an article to
 * queue. Each test reads at most a row or two of an index. */
/** A job outside the folder that source cleanup can remove: one whose note still has
 * projection rows waits for the projection step to cancel them instead. */
const RETIRABLE_JOB = 'NOT EXISTS (SELECT 1 FROM reminder_projections WHERE file_path = j.path)';
const PASS_PROBE_SQL = `SELECT ${ENCRYPTION_STATE_SQL} AS encryption, ${serverStateValue('features')} AS features,
    EXISTS(SELECT 1 FROM server_state WHERE id = 1 AND import_state = 'importing') AS importing,
    ${NOTIFICATION_POLICY_COLUMNS.split(', ').map(column => `p.${column} AS ${column}`).join(', ')},
    r.enabled AS reading_enabled, r.folder_path AS reading_folder, r.generation AS reading_generation, r.revision AS reading_revision,
    r.index_scope AS reading_scope, r.index_cursor AS reading_cursor,
    EXISTS(SELECT 1 FROM reading_captures) OR r.enabled = 1 AND (EXISTS(SELECT 1 FROM reading_jobs)
      OR EXISTS(SELECT 1 FROM reading_items WHERE article_hash IS NOT NULL)) AS reading_work,
    EXISTS(SELECT 1 FROM notification_projection_jobs WHERE last_error IS NULL) AS ready,
    (SELECT available_at FROM notification_file_retries WHERE available_at >= 0 ORDER BY available_at, path LIMIT 1) AS retry_at,
    (SELECT due_at FROM reminder_projections WHERE due_at IS NOT NULL ORDER BY due_at LIMIT 1) AS dispatch_at,
    CASE WHEN p.folder_path IS NULL THEN EXISTS(SELECT 1 FROM reminder_source_state) OR EXISTS(SELECT 1 FROM reminder_sources)
        OR EXISTS(SELECT 1 FROM notification_projection_jobs j WHERE ${RETIRABLE_JOB})
      ELSE EXISTS(SELECT 1 FROM reminder_source_state WHERE file_path < p.folder_path || '/')
        OR EXISTS(SELECT 1 FROM reminder_source_state WHERE file_path >= p.folder_path || '0')
        OR EXISTS(SELECT 1 FROM reminder_sources WHERE file_path < p.folder_path || '/')
        OR EXISTS(SELECT 1 FROM reminder_sources WHERE file_path >= p.folder_path || '0')
        OR EXISTS(SELECT 1 FROM notification_projection_jobs j WHERE path < p.folder_path || '/' AND ${RETIRABLE_JOB})
        OR EXISTS(SELECT 1 FROM notification_projection_jobs j WHERE path >= p.folder_path || '0' AND ${RETIRABLE_JOB})
        OR (SELECT value FROM maintenance_state WHERE key = ? || ':' || p.folder_path) IS NOT ''
        OR EXISTS(SELECT 1 FROM reminder_source_state WHERE parser_version < ?
          AND +file_path >= p.folder_path || '/' AND +file_path < p.folder_path || '0') END AS source_work
  FROM (SELECT 1) LEFT JOIN notification_policy p ON p.id = 1 LEFT JOIN reading_policy r ON r.id = 1`;

interface PassProbe extends NotificationPolicyRow {
	encryption: string | null; features: string | null; importing: number;
	reading_enabled: number | null; reading_folder: string | null; reading_generation: string | null; reading_revision: string | null;
	reading_scope: string | null; reading_cursor: string | null; reading_work: number;
	ready: number; retry_at: number | null; dispatch_at: number | null; source_work: number;
}

export async function runNotificationCoordinator(state: DurableObjectState, env: Env): Promise<NotificationPassResult> {
	// One read decides whether the pass has work and loads what each sub-step would otherwise reload.
	const loaded = await env.DB.prepare(PASS_PROBE_SQL).bind(SCAN_KEY, REMINDER_CACHE_PARSER_VERSION).first<PassProbe>();
	const encryption = parseEncryptionState(loaded?.encryption ?? null);
	const idle: NotificationPassResult = { wrote: false, dispatchAt: undefined };
	if (encryption?.mode === 'resetting') return idle;
	if (loaded?.importing) return idle;
	const features = parseStoredFeaturePolicy(loaded?.features ?? null);
	const policy = notificationPolicyFromRow(loaded);
	const reading = loaded?.reading_folder != null ? { enabled: loaded.reading_enabled ?? 0, folder_path: loaded.reading_folder,
		generation: loaded.reading_generation ?? '', revision: loaded.reading_revision ?? '' } : null;
	// An encrypted vault has no Reading jobs, but an incomplete index is rebuilt here too.
	const readingIdle = !features.reading || !reading
		|| (completeReadingIndex(reading, loaded?.reading_scope == null ? null : { scope: loaded.reading_scope, cursor: loaded.reading_cursor }) !== null && (encryption !== null || !loaded?.reading_work));
	const retryAt = loaded?.retry_at ?? null;
	const retryDue = retryAt !== null && retryAt <= Date.now();
	const sourcesIdle = !loaded?.source_work && !retryDue;
	const remindersIdle = !features.reminders || (!loaded?.ready && sourcesIdle);
	if (readingIdle && remindersIdle) {
		if (!features.reminders) return idle;
		// Failed jobs sleep until due; an idle coordinator leaves no other alarm behind.
		if (retryAt !== null) await state.storage.setAlarm(Math.max(Date.now() + 1, retryAt));
		return { wrote: false, dispatchAt: policy ? loaded?.dispatch_at ?? null : undefined };
	}
	const readingAt = readingIdle ? null : await scheduleReading(env, { encryption, features });
	let sourceWork = false;
	if (!features.reminders) {
		if (readingAt !== null) await state.storage.setAlarm(readingAt);
		return idle;
	}
	let hasPolicy = false, wrote = false;
	let pending: NotificationWork | null | undefined;
	try {
		// Source verification and projection share this budget. Delivery has its own
		// invocation on the dispatcher, so a reminder backlog does not compete with source scans.
		hasPolicy = Boolean(policy);
		const verified = new Map<string, VerifiedSourceBytes>();
		if (!sourcesIdle) sourceWork = await revalidateReminderSources(env, FILES_PER_PASS, { folder: policy?.folderPath ?? null, encryption }, verified);
		if (hasPolicy) {
			wrote = await drainNotificationProjections(env, FILES_PER_PASS, { features, policy, encryption, verified });
			pending = await nextNotificationWork(env.DB);
		}
	} finally {
		if (sourceWork) {
			await state.storage.setAlarm(Date.now() + 1);
		} else {
			const source = hasPolicy ? null : await env.DB.prepare(NEXT_SOURCE_RETRY_SQL)
				.first<{ retryAt: number | null }>();
			if (pending === undefined) pending = hasPolicy ? await nextNotificationWork(env.DB) : null;
			// Due reminders wake the dispatcher, not the coordinator.
			const deadlines = [readingAt, source?.retryAt, pending?.projectionRetry,
				...(pending?.ready ? [0] : [])].filter((value): value is number => typeof value === 'number');
			// Continue ready work immediately in a fresh invocation with its own budget.
			// Idle coordinators leave no alarm behind; failed jobs sleep until due.
			if (deadlines.length) await state.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
		}
	}
	return { wrote, dispatchAt: hasPolicy ? pending?.dispatchAt ?? null : undefined };
}
