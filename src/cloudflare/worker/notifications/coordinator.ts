import { featurePolicy } from '../feature-policy';
import { scheduleReading } from '../reading/extraction/jobs';
import { NEXT_NOTIFICATION_WORK_SQL, NEXT_SOURCE_RETRY_SQL } from './queue';
import { getNotificationPolicy } from './policy';
import type { Env } from '../types';
import { drainNotificationProjections } from './projection';
import { revalidateReminderSources } from '../reminders/source-migration';
import { readEncryptionState } from '../encryption/state';

type NotificationWork = { ready: number; projectionRetry: number | null; dispatchAt: number | null };

function nextNotificationWork(db: D1Database): Promise<NotificationWork | null> {
	return db.prepare(NEXT_NOTIFICATION_WORK_SQL).first<NotificationWork>();
}

/** Returns whether schedule dispatch is due. The caller dispatches after releasing the
 * coordinator lock; the alarm set here already covers the pass that follows it. */
export async function runNotificationCoordinator(state: DurableObjectState, env: Env): Promise<boolean> {
	const encryption = await readEncryptionState(env.DB);
	if (encryption?.mode === 'resetting') return false;
	if (await env.DB.prepare("SELECT 1 FROM initial_import WHERE state = 'importing'").first()) return false;
	// Each sub-step would otherwise reload these rows within the same query budget.
	const features = await featurePolicy(env.DB);
	const readingAt = await scheduleReading(env, { encryption, features });
	let sourceWork = false;
	if (!features.reminders) {
		if (readingAt !== null) await state.storage.setAlarm(readingAt);
		return false;
	}
	let hasPolicy = false, dispatch = false;
	let pending: NotificationWork | null | undefined;
	try {
		// Source verification and projection share this budget. Dispatch has its own
		// invocation so a reminder backlog does not compete with source scans.
		// Encrypted descriptors need extra reads; leave room for shared feature and
		// Reading scheduling checks within the per-invocation query budget.
		const policy = await getNotificationPolicy(env.DB);
		hasPolicy = Boolean(policy);
		sourceWork = await revalidateReminderSources(env, encryption ? 1 : 2, { folder: policy?.folderPath ?? null, encryption });
		if (hasPolicy) {
			await drainNotificationProjections(env, 1, { features, policy, encryption });
			// Skip the dispatcher hop when no alarm update is due yet.
			pending = await nextNotificationWork(env.DB);
			dispatch = pending?.dispatchAt != null && pending.dispatchAt <= Date.now();
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
	return dispatch;
}
