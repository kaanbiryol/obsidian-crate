import { NEXT_NOTIFICATION_WORK_SQL, NEXT_SOURCE_RETRY_SQL } from './notification-queue';
import { getNotificationPolicy } from './notification-policy';
import type { Env } from './types';
import { drainNotificationProjections } from './notification-projection';
import { drainNotificationJobs } from './notification-outbox';
import { revalidateReminderSources } from './reminder-source-migration';

export async function runNotificationCoordinator(state: DurableObjectState, env: Env): Promise<void> {
  let sourceWork = false;
  let hasPolicy = false;
  try {
    // Migration, projection and dispatch share this invocation's D1 budget.
    // Small durable slices keep progress below the conservative Free-plan limit.
    sourceWork = await revalidateReminderSources(env, 2);
    hasPolicy = Boolean(await getNotificationPolicy(env.DB));
    if (hasPolicy) {
      await drainNotificationProjections(env, 1);
      await drainNotificationJobs(env, 2);
    }
  } finally {
    if (sourceWork) {
      await state.storage.setAlarm(Date.now() + 1_000);
    } else {
      const source = hasPolicy ? null : await env.DB.prepare(NEXT_SOURCE_RETRY_SQL)
        .first<{ retryAt: number | null }>();
      const pending = hasPolicy ? await env.DB.prepare(NEXT_NOTIFICATION_WORK_SQL)
        .first<{ ready: number; projectionRetry: number | null; dispatchAt: number | null }>() : null;
      const deadlines = [source?.retryAt, pending?.projectionRetry, pending?.dispatchAt,
        ...(pending?.ready ? [0] : [])].filter((value): value is number => typeof value === 'number');
      // Idle coordinators leave no alarm behind. Failed jobs sleep until due.
      if (deadlines.length) await state.storage.setAlarm(Math.max(Date.now() + 1_000, Math.min(...deadlines)));
    }
  }
}
