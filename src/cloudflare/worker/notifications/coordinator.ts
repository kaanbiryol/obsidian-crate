import { parseStoredFeaturePolicy } from '../server/feature-policy';
import { scheduleReading } from '../reading/extraction/jobs';
import { NEXT_NOTIFICATION_WORK_SQL, NEXT_SOURCE_RETRY_SQL } from './queue';
import { NOTIFICATION_POLICY_COLUMNS, notificationPolicyFromRow, type NotificationPolicyRow } from './policy';
import type { Env } from '../types';
import { drainNotificationProjections } from './projection';
import { revalidateReminderSources, type VerifiedSourceBytes } from '../reminders/source-migration';
import { ENCRYPTION_STATE_SQL, parseEncryptionState } from '../encryption/state';
import { serverStateValue } from '../d1/server-state';

type NotificationWork = { ready: number; projectionRetry: number | null; dispatchAt: number | null };

// Files each pass verifies and then projects, about two D1 queries each. The worst case,
// 39 queries with a Reading index page, stays within D1_QUERIES_PER_INVOCATION
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

export async function runNotificationCoordinator(state: DurableObjectState, env: Env): Promise<NotificationPassResult> {
	// Each sub-step would otherwise reload these rows within the same query budget.
	const loaded = await env.DB.prepare(`SELECT ${ENCRYPTION_STATE_SQL} AS encryption, ${serverStateValue('features')} AS features,
    EXISTS(SELECT 1 FROM initial_import WHERE state = 'importing') AS importing, ${NOTIFICATION_POLICY_COLUMNS}
    FROM (SELECT 1) LEFT JOIN notification_policy p ON p.id = 1`)
		.first<NotificationPolicyRow & { encryption: string | null; features: string | null; importing: number }>();
	const encryption = parseEncryptionState(loaded?.encryption ?? null);
	const idle: NotificationPassResult = { wrote: false, dispatchAt: undefined };
	if (encryption?.mode === 'resetting') return idle;
	if (loaded?.importing) return idle;
	const features = parseStoredFeaturePolicy(loaded?.features ?? null);
	const readingAt = await scheduleReading(env, { encryption, features });
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
		const policy = notificationPolicyFromRow(loaded);
		hasPolicy = Boolean(policy);
		const verified = new Map<string, VerifiedSourceBytes>();
		sourceWork = await revalidateReminderSources(env, FILES_PER_PASS, { folder: policy?.folderPath ?? null, encryption }, verified);
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
