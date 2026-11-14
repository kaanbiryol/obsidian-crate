import { NOTIFICATION_DELIVERY_WINDOW_MS, notificationDatetime } from './core/notification-time';
import { readableLinkText } from './core/grammar/markdownLinks';
import type { IndexedReminder } from './data/reminder-index';

/** Longest wait between checks, so a reminder due during sleep or a clock change fires soon after. */
export const MAX_CHECK_DELAY_MS = 5 * 60_000;
/** More reminders than this falling due together show one summary instead. */
const MAX_SEPARATE_NOTIFICATIONS = 3;

export interface LocalNotification {
	title: string;
	body: string;
	tag: string;
}

export interface LocalNotificationHost {
	/** Not-completed reminders, or null until the folder has fully loaded. */
	reminders(): readonly IndexedReminder[] | null;
	schedule(): { allDayTime: string | null; timezone: string };
	/** Whether this device shows notifications now. Checks still run while it does not, so
	 * turning them on later never replays reminders that fell due meanwhile. */
	isActive(): boolean;
	show(notification: LocalNotification): void;
	/** When this device last checked, kept outside the vault so other devices never share it. */
	loadLastChecked(): number | null;
	saveLastChecked(at: number): void;
	now?: () => number;
}

/** Notifies reminders that fall due while Obsidian runs, and those due since the last
 * check up to the Worker's 24-hour window. A reminder whose due time had already passed
 * when this device first saw it does not notify, as on the Worker. */
export function startLocalReminderNotifications(host: LocalNotificationHost, signal: AbortSignal): { refresh: () => void } {
	const now = host.now ?? Date.now;
	let timer: number | undefined;

	const cancel = () => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = undefined;
	};
	const check = () => {
		cancel();
		if (signal.aborted) return;
		const reminders = host.reminders();
		if (!reminders) return;
		const at = now();
		const last = host.loadLastChecked();
		const schedule = host.schedule();
		const due: IndexedReminder[] = [];
		let next = Infinity;
		for (const reminder of reminders) {
			const iso = notificationDatetime(reminder, schedule);
			const time = iso ? Date.parse(iso) : NaN;
			if (Number.isNaN(time)) continue;
			if (time > at) next = Math.min(next, time);
			else if (last !== null && time > last && at - time < NOTIFICATION_DELIVERY_WINDOW_MS) due.push(reminder);
		}
		host.saveLastChecked(at);
		if (due.length && host.isActive()) deliver(host, due);
		timer = window.setTimeout(check, Math.min(next - at, MAX_CHECK_DELAY_MS));
	};

	signal.addEventListener('abort', cancel, { once: true });
	check();
	return { refresh: check };
}

function deliver(host: LocalNotificationHost, due: IndexedReminder[]): void {
	if (due.length > MAX_SEPARATE_NOTIFICATIONS) {
		host.show({
			title: `${due.length} reminders are due`,
			body: due.slice(0, MAX_SEPARATE_NOTIFICATIONS).map(reminder => readableLinkText(reminder.content)).join(', ') + '…',
			tag: 'crate-reminders-summary',
		});
		return;
	}
	for (const reminder of due) host.show({ title: readableLinkText(reminder.content), body: reminder.project ?? '', tag: reminder.id });
}
