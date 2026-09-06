import { errorMessage } from '../../plugin/logger';
import type { CrateSettings } from '../../plugin/settings-types';
import type { SyncApiClient } from '../../sync/api';
import type { RemindersSettings } from '../settings';
import type { Reminder } from '../types/reminder';

type SchedulableReminder = Pick<Reminder, 'id' | 'content' | 'dueDate' | 'dueDatetime' | 'priority' | 'completed' | 'project'>;

export class ReminderNotificationService {
  private active: Promise<void> | null = null;
  constructor(private getSettings: () => CrateSettings, private getRemindersSettings: () => RemindersSettings, private getApiClient: () => SyncApiClient | null) {}
  private refresh(): Promise<void> {
    const api = this.getApiClient();
    if (!this.getSettings().pushEnabled || !api) return Promise.resolve();
    if (this.active) return this.active;
    const settings = this.getRemindersSettings();
    const work = api.ensureNotificationPolicy({ folderPath: settings.remindersFolderPath,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDayTime: settings.allDayNotificationTime }).then(() => undefined);
    this.active = work;
    void work.finally(() => { if (this.active === work) this.active = null; }).catch(() => undefined);
    return work;
  }
  onReminderCreated(_reminder: SchedulableReminder): Promise<void> { return this.refresh(); }
  onReminderUpdated(_reminder: SchedulableReminder): Promise<void> { return this.refresh(); }
  onReminderDeleted(_reminderId: string): Promise<void> { return this.refresh(); }
  async onReminderChange(_reminder: SchedulableReminder, _operation: 'create' | 'update' | 'delete'): Promise<{ success: boolean; error?: string }> {
    try { await this.refresh(); return { success: true }; }
    catch (error) { return { success: false, error: errorMessage(error) }; }
  }
  reconcile(_reminders: SchedulableReminder[]): Promise<void> { return this.refresh(); }
  // Turning off this device's push does not cancel other devices' schedules.
  cancelAll(): Promise<void> { return Promise.resolve(); }
}
