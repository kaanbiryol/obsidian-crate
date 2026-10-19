import { applyReminderSettlement, type createReminderSettlementChannel } from './reminder-settlement';
import type { ReminderOutboxStorage } from './reminder-outbox-storage';
import type { createReminderOutbox } from './reminder-outbox';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { CachedReminderSnapshot, LoadReminders, ReminderRecord, ShowToast } from './types';

const PEER_REFRESH_DELAY_MS = 100;

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
		commitReminderState: (reminders: ReminderRecord[], projects?: string[], options?: { persist?: boolean }) => void | Promise<void>;
		loadReminders: LoadReminders;
		showToast: ShowToast;
	};
}): () => void {
	const { storage, recovery, settlement, outbox } = options;
	const browser = window, page = document;
	let subscribed = true;
	const isCurrent = () => subscribed && options.isCurrent();
	const resume = () => { if (isCurrent()) options.resume(); };
	// A hidden peer already applied the confirmed result. It defers the list read
	// until it is shown, so one save does not download the list in every tab.
	let refreshWhenVisible = false;
	// One remote save arrives as a confirmation and a command removal; read once.
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const refreshList = () => {
		if (page.visibilityState === 'hidden') { refreshWhenVisible = true; return; }
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			if (isCurrent()) void options.current().loadReminders({ silent: true });
		}, PEER_REFRESH_DELAY_MS);
	};
	// A burst of peer key writes rereads the queue once. Earlier-session keys are
	// read only when one of them changed. Hidden tabs wait until they are shown.
	let outboxTimer: ReturnType<typeof setTimeout> | undefined;
	let recoveryChanged = false;
	const loadRecovery = () => {
		if (!recoveryChanged) return;
		recoveryChanged = false;
		options.setRecoveryChanges(recovery.load());
	};
	const syncOutbox = () => {
		outboxTimer = undefined;
		if (!isCurrent() || page.visibilityState === 'hidden') return;
		try { loadRecovery(); outbox.refresh(); void outbox.drain(); }
		catch (error) { options.current().showToast('error', error instanceof Error ? error.message : String(error)); }
	};
	const visible = () => {
		if (page.visibilityState !== 'visible') return;
		if (refreshWhenVisible && isCurrent()) { refreshWhenVisible = false; void options.current().loadReminders({ silent: true }); }
		if (isCurrent()) {
			try { loadRecovery(); } catch (error) { options.current().showToast('error', error instanceof Error ? error.message : String(error)); }
		}
		resume();
	};
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
					// The sender persisted this result before publishing it.
					if (next) await current.commitReminderState(next.reminders, next.projects, { persist: false });
				} catch (error) { if (isCurrent()) current.showToast('error', error instanceof Error ? error.message : String(error)); }
				finally { finish(); if (isCurrent()) refreshList(); }
			})();
			return;
		}
		if (!recovery.acceptsKey(event.key)) return;
		// A missed confirmation still invalidates stale reads when its command disappears.
		if (storage.acceptsKey(event.key) && event.oldValue && event.newValue === null) {
			const finish = options.current().beginLocalMutation();
			finish();
			refreshList();
		}
		if (event.key === null || !storage.acceptsKey(event.key)) recoveryChanged = true;
		outboxTimer ??= setTimeout(syncOutbox, PEER_REFRESH_DELAY_MS);
	};
	browser.addEventListener('online', resume);
	page.addEventListener('visibilitychange', visible);
	browser.addEventListener('storage', storageChanged);
	return () => {
		subscribed = false;
		clearTimeout(refreshTimer);
		clearTimeout(outboxTimer);
		browser.removeEventListener('online', resume);
		page.removeEventListener('visibilitychange', visible);
		browser.removeEventListener('storage', storageChanged);
	};
}
