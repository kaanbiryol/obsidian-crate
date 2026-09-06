import { getNotificationPolicy } from './notification-policy';
import type { Env } from './types';
import { drainNotificationProjections } from './notification-projection';
import { drainNotificationJobs } from './notification-outbox';

export async function wakeNotificationCoordinator(env: Env): Promise<void> {
  const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
  const response = await stub.fetch('https://do/project', { method: 'POST' });
  if (!response.ok) throw new Error('Notification projection wakeup failed; maintenance will retry');
}

export async function runNotificationCoordinator(state: DurableObjectState, env: Env): Promise<void> {
  if (!await getNotificationPolicy(env.DB)) return;
  try {
    await drainNotificationProjections(env, 3);
    await drainNotificationJobs(env, 5);
  } finally {
    const pending = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM notification_projection_jobs) + (SELECT COUNT(*) FROM notification_jobs) AS count,
      (SELECT COUNT(*) FROM notification_projection_jobs WHERE last_error IS NULL) +
      (SELECT COUNT(*) FROM notification_jobs WHERE available_at <= ?) AS ready`).bind(Date.now()).first<{ count: number; ready: number }>();
    if (pending?.count) await state.storage.setAlarm(Date.now() + (pending.ready > 0 ? 1_000 : 60_000));
  }
}
