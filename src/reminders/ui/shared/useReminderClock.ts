import { useEffect, useSyncExternalStore } from 'react';
import { createReminderClock } from './reminder-clock';

const clock = createReminderClock();
const empty: readonly { dueDatetime?: string }[] = [];

/** Time is a selector input even when the server returns an unchanged snapshot. */
export function useReminderClock(reminders: readonly { dueDatetime?: string }[] = empty) {
	const snapshot = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
	useEffect(() => clock.track(reminders.map(reminder => reminder.dueDatetime)), [reminders]);
	return snapshot;
}
