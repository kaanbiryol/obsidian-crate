import { expect, it, vi } from 'vitest';
import { adoptReminderFolder, loadStoredConfig, PWA_FOLDER_CHANGED_EVENT } from './config';

it('adopts a moved reminders folder once and keeps the other settings', () => {
	const values = new Map([['crate-reminders-config', JSON.stringify({ folderPath: 'Reminders', upcomingDays: 3, allDayNotificationTime: '08:00' })]]);
	vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
	const events: string[] = [];
	vi.stubGlobal('window', { dispatchEvent: (event: Event) => events.push(event.type) });
	adoptReminderFolder('Tasks');
	adoptReminderFolder('Tasks');
	expect(loadStoredConfig()).toEqual({ folderPath: 'Tasks', upcomingDays: 3, allDayNotificationTime: '08:00' });
	expect(events).toEqual([PWA_FOLDER_CHANGED_EVENT]);
	vi.unstubAllGlobals();
});
