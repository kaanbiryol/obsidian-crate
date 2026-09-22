import { scheduleReading } from './reading/extraction/jobs';
import { NEXT_NOTIFICATION_WORK_SQL, NEXT_SOURCE_RETRY_SQL } from './notification-queue';
import { getNotificationPolicy } from './notification-policy';
import type { Env } from './types';
import { drainNotificationProjections } from './notification-projection';
import { dispatchNotificationJobs } from './notification-outbox';
import { revalidateReminderSources } from './reminder-source-migration';

export async function runNotificationCoordinator(state: DurableObjectState, env: Env): Promise<void> {
  if (await env.DB.prepare("SELECT 1 FROM initial_import WHERE state = 'importing'").first()) return;
  let sourceWork = await scheduleReading(env);
  let hasPolicy = false;
  try {
    // Source verification and projection share this budget. Dispatch has its own
    // invocation so a reminder backlog does not compete with source scans.
    const policy = await getNotificationPolicy(env.DB);
    hasPolicy = Boolean(policy);
    sourceWork = (await revalidateReminderSources(env, 2, { folder: policy?.folderPath ?? null })) || sourceWork;
    if (hasPolicy) {
      await drainNotificationProjections(env, 1);
      await dispatchNotificationJobs(env);
    }
  } finally {
    if (sourceWork) {
      await state.storage.setAlarm(Date.now() + 1);
    } else {
      const source = hasPolicy ? null : await env.DB.prepare(NEXT_SOURCE_RETRY_SQL)
        .first<{ retryAt: number | null }>();
      const pending = hasPolicy ? await env.DB.prepare(NEXT_NOTIFICATION_WORK_SQL)
        .first<{ ready: number; projectionRetry: number | null; dispatchAt: number | null }>() : null;
      const deadlines = [source?.retryAt, pending?.projectionRetry, pending?.dispatchAt,
        ...(pending?.ready ? [0] : [])].filter((value): value is number => typeof value === 'number');
      // Continue ready work immediately in a fresh invocation with its own budget.
      // Idle coordinators leave no alarm behind; failed jobs sleep until due.
      if (deadlines.length) await state.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
    }
  }
}
