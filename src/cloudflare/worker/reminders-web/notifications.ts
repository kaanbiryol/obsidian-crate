import { wakeNotificationCoordinator } from '../notification-coordinator';
import type { Env } from '../types';
import type { RemoteReminderRecord } from './types';

async function projectNotifications(env: Env): Promise<string | undefined> {
  try {
    await wakeNotificationCoordinator(env);
    return undefined;
  } catch {
    return 'Notification updates are queued and will retry automatically.';
  }
}
export function syncReminderNotification(env: Env, _reminder: RemoteReminderRecord | null, _allDayTime: string | null | undefined): Promise<string | undefined> {
  return projectNotifications(env);
}
export function cancelReminderNotification(env: Env, _reminderId: string): Promise<string | undefined> {
  return projectNotifications(env);
}
