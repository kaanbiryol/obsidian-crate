import { resetLocalTimeZone } from '@internationalized/date';

export interface ReminderClockSnapshot { now: Date; timezone: string }

/** One timer and one set of listeners serve all mounted reminder views/cards. */
export function createReminderClock() {
	let snapshot: ReminderClockSnapshot = { now: new Date(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
	const listeners = new Set<() => void>();
	const deadlines = new Map<symbol, number[]>();
	let timer: number | undefined;
	const update = () => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (timezone !== snapshot.timezone) resetLocalTimeZone();
		snapshot = { now: new Date(), timezone };
		for (const listener of listeners) listener();
	};
	const schedule = () => {
		window.clearTimeout(timer);
		if (!listeners.size) return;
		const now = Date.now();
		// Calendar boundaries, manual clock changes and timezone changes are
		// checked at least once a minute. Timed reminders can expire sooner.
		let next = now + (60_000 - now % 60_000);
		for (const values of deadlines.values()) for (const deadline of values) {
			if (deadline >= now) next = Math.min(next, deadline + 1);
		}
		timer = window.setTimeout(refresh, Math.max(1, next - now));
	};
	const refresh = () => { update(); schedule(); };
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			if (listeners.size === 1) {
				window.addEventListener('focus', refresh);
				window.addEventListener('pageshow', refresh);
				document.addEventListener('visibilitychange', refresh);
				refresh();
			}
			return () => {
				listeners.delete(listener);
				if (!listeners.size) {
					window.clearTimeout(timer);
					window.removeEventListener('focus', refresh);
					window.removeEventListener('pageshow', refresh);
					document.removeEventListener('visibilitychange', refresh);
				}
			};
		},
		track(dueTimes: readonly (string | undefined)[]) {
			const key = Symbol();
			deadlines.set(key, dueTimes.map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite));
			schedule();
			return () => { deadlines.delete(key); schedule(); };
		},
	};
}
