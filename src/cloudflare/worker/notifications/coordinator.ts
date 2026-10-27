import { parseStoredFeaturePolicy } from '../feature-policy';
import { scheduleReading } from '../reading/extraction/jobs';
import { NEXT_NOTIFICATION_WORK_SQL, NEXT_SOURCE_RETRY_SQL } from './queue';
import { NOTIFICATION_POLICY_COLUMNS, notificationPolicyFromRow, type NotificationPolicyRow } from './policy';
import type { Env } from '../types';
import { drainNotificationProjections } from './projection';
import { dispatchNotificationJobs } from './outbox';
import { revalidateReminderSources } from '../reminders/source-migration';
import { ENCRYPTION_STATE_SQL, parseEncryptionState } from '../encryption/state';
import { serverStateValue } from '../server-state';

type NotificationWork = { ready: number; projectionRetry: number | null; dispatchAt: number | null };

function nextNotificationWork(db: D1Database): Promise<NotificationWork | null> {
	return db.prepare(NEXT_NOTIFICATION_WORK_SQL).first<NotificationWork>();
}

export async function runNotificationCoordinator(state: DurableObjectState, env: Env): Promise<void> {
	// Each sub-step would otherwise reload these rows within the same query budget.
	const loaded = await env.DB.prepare(`SELECT ${ENCRYPTION_STATE_SQL} AS encryption, ${serverStateValue('features')} AS features,
    EXISTS(SELECT 1 FROM initial_import WHERE state = 'importing') AS importing, ${NOTIFICATION_POLICY_COLUMNS}
    FROM (SELECT 1) LEFT JOIN notification_policy p ON p.id = 1`)
		.first<NotificationPolicyRow & { encryption: string | null; features: string | null; importing: number }>();
	const encryption = parseEncryptionState(loaded?.encryption ?? null);
	if (encryption?.mode === 'resetting') return;
	if (loaded?.importing) return;
	const features = parseStoredFeaturePolicy(loaded?.features ?? null);
	const readingAt = await scheduleReading(env, { encryption, features });
	let sourceWork = false;
	if (!features.reminders) {
		if (readingAt !== null) await state.storage.setAlarm(readingAt);
		return;
	}
	let hasPolicy = false;
	let pending: NotificationWork | null | undefined;
	try {
		// Source verification and projection share this budget. Dispatch has its own
		// invocation so a reminder backlog does not compete with source scans.
		// Encrypted descriptors need extra reads; leave room for shared feature and
		// Reading scheduling checks within the per-invocation query budget.
		const policy = notificationPolicyFromRow(loaded);
		hasPolicy = Boolean(policy);
		sourceWork = await revalidateReminderSources(env, encryption ? 1 : 2, { folder: policy?.folderPath ?? null, encryption });
		if (hasPolicy) {
			await drainNotificationProjections(env, 1, { features, policy, encryption });
			// Skip the dispatcher hop when no alarm update is due yet.
			pending = await nextNotificationWork(env.DB);
			if (pending?.dispatchAt != null && pending.dispatchAt <= Date.now()) {
				pending = undefined;
				await dispatchNotificationJobs(env, true);
			}
		}
	} finally {
		if (sourceWork) {
			await state.storage.setAlarm(Date.now() + 1);
		} else {
			const source = hasPolicy ? null : await env.DB.prepare(NEXT_SOURCE_RETRY_SQL)
				.first<{ retryAt: number | null }>();
			if (pending === undefined) pending = hasPolicy ? await nextNotificationWork(env.DB) : null;
			const deadlines = [readingAt, source?.retryAt, pending?.projectionRetry, pending?.dispatchAt,
				...(pending?.ready ? [0] : [])].filter((value): value is number => typeof value === 'number');
			// Continue ready work immediately in a fresh invocation with its own budget.
			// Idle coordinators leave no alarm behind; failed jobs sleep until due.
			if (deadlines.length) await state.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
		}
	}
}
