import { resetLocalTimeZone } from '@internationalized/date';

interface ReminderClockSnapshot { now: Date; timezone: string }

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
	let scheduledAt = Infinity;
	const setTimer = (at: number, now: number) => {
		window.clearTimeout(timer);
		scheduledAt = at;
		timer = window.setTimeout(refresh, Math.max(1, at - now));
	};
	const stopTimer = () => { window.clearTimeout(timer); scheduledAt = Infinity; };
	const schedule = () => {
		if (!listeners.size) return stopTimer();
		const now = Date.now();
		// Calendar boundaries, manual clock changes and timezone changes are
		// checked at least once a minute. Timed reminders can expire sooner.
		let next = now + (60_000 - now % 60_000);
		for (const values of deadlines.values()) for (const deadline of values) {
			if (deadline >= now) next = Math.min(next, deadline + 1);
		}
		setTimer(next, now);
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
					stopTimer();
					window.removeEventListener('focus', refresh);
					window.removeEventListener('pageshow', refresh);
					document.removeEventListener('visibilitychange', refresh);
				}
			};
		},
		// Every card tracks its own deadline. A new deadline can only move the
		// timer earlier, so tracking does not rescan all cards. A removed
		// deadline causes at most one early refresh, which reschedules.
		track(dueTimes: readonly (string | undefined)[]) {
			const key = Symbol();
			const values = dueTimes.map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
			deadlines.set(key, values);
			if (listeners.size) {
				const now = Date.now();
				for (const deadline of values) {
					if (deadline >= now && deadline + 1 < scheduledAt) setTimer(deadline + 1, now);
				}
			}
			return () => { deadlines.delete(key); };
		},
	};
}
