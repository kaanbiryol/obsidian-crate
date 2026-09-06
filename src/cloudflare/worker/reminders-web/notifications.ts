import { wakeNotificationCoordinator } from '../notification-coordinator';
import type { Env } from '../types';

export async function projectReminderNotifications(env: Env): Promise<string | undefined> {
  try {
    await wakeNotificationCoordinator(env);
    return undefined;
  } catch {
    return 'Notification updates are queued and will retry automatically.';
  }
}
