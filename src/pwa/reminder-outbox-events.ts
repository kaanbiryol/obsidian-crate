import { applyReminderSettlement, type createReminderSettlementChannel } from './reminder-settlement';
import type { ReminderOutboxStorage } from './reminder-outbox-storage';
import type { createReminderOutbox } from './reminder-outbox';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { CachedReminderSnapshot, LoadReminders, ReminderRecord, ShowToast } from './types';

/** Browser wakeups and peer confirmations share one subscription lifetime. */
export function subscribeReminderOutboxEvents(options: {
	isCurrent: () => boolean;
	resume: () => void;
	storage: Pick<ReminderOutboxStorage, 'acceptsKey'>;
	recovery: Pick<ReminderOutboxStorage, 'acceptsKey' | 'load'>;
	settlement: Pick<Awaited<ReturnType<typeof createReminderSettlementChannel>>, 'key' | 'read'>;
	outbox: Pick<ReturnType<typeof createReminderOutbox>, 'refresh' | 'drain'>;
	setRecoveryChanges: (changes: PendingReminderChange[]) => void;
	current: () => {
		hasSnapshot?: boolean;
		beginLocalMutation: () => () => void;
		getSnapshot: () => Pick<CachedReminderSnapshot, 'reminders' | 'projects'>;
		commitReminderState: (reminders: ReminderRecord[], projects?: string[]) => void | Promise<void>;
		loadReminders: LoadReminders;
		showToast: ShowToast;
	};
}): () => void {
	const { storage, recovery, settlement, outbox } = options;
	const browser = window, page = document;
	let subscribed = true;
	const isCurrent = () => subscribed && options.isCurrent();
	const resume = () => { if (isCurrent()) options.resume(); };
	const visible = () => { if (page.visibilityState === 'visible') resume(); };
	const storageChanged = (event: StorageEvent) => {
		if (!isCurrent()) return;
		if (event.key === settlement.key && event.newValue) {
			const confirmed = settlement.read(event);
			const current = options.current();
			const finish = current.beginLocalMutation();
			void (async () => {
				try {
					const snapshot = current.getSnapshot();
					const next = confirmed && current.hasSnapshot !== false ? applyReminderSettlement(snapshot.reminders, snapshot.projects, confirmed) : null;
					if (next) await current.commitReminderState(next.reminders, next.projects);
				} catch (error) { if (isCurrent()) current.showToast('error', error instanceof Error ? error.message : String(error)); }
				finally { finish(); if (isCurrent()) void options.current().loadReminders({ silent: true }); }
			})();
			return;
		}
		if (!recovery.acceptsKey(event.key)) return;
		try {
			// A missed confirmation still invalidates stale reads when its command disappears.
			if (storage.acceptsKey(event.key) && event.oldValue && event.newValue === null) {
				const finish = options.current().beginLocalMutation();
				finish();
				void options.current().loadReminders({ silent: true });
			}
			options.setRecoveryChanges(recovery.load()); outbox.refresh(); void outbox.drain();
		} catch (error) { options.current().showToast('error', error instanceof Error ? error.message : String(error)); }
	};
	browser.addEventListener('online', resume);
	page.addEventListener('visibilitychange', visible);
	browser.addEventListener('storage', storageChanged);
	return () => {
		subscribed = false;
		browser.removeEventListener('online', resume);
		page.removeEventListener('visibilitychange', visible);
		browser.removeEventListener('storage', storageChanged);
	};
}
