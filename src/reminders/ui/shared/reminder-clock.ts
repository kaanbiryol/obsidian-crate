import { resetLocalTimeZone } from '@internationalized/date';
import { resetDateFormatterCache } from '../format/dateFormatting';
import { formatLocalDateKey } from '../../core/dates/reminderDate';

interface ReminderClockSnapshot { now: Date; timezone: string }

/** One timer and one set of listeners serve all mounted reminder views/cards. */
export function createReminderClock() {
	let snapshot: ReminderClockSnapshot = { now: new Date(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
	const listeners = new Set<() => void>();
	const deadlines = new Map<symbol, number[]>();
	let timer: number | undefined;
	// Views only depend on the local day, the timezone and which tracked
	// deadlines have passed. Keeping the previous snapshot otherwise lets
	// subscribers skip re-rendering on minute ticks and resume events.
	const crossesDeadline = (from: number, to: number) => {
		const low = Math.min(from, to);
		const high = Math.max(from, to);
		for (const values of deadlines.values()) for (const deadline of values) {
			if (deadline >= low && deadline <= high) return true;
		}
		return false;
	};
	const update = () => {
		const now = new Date();
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (timezone !== snapshot.timezone) { resetLocalTimeZone(); resetDateFormatterCache(); }
		else if (formatLocalDateKey(now) === formatLocalDateKey(snapshot.now)
			&& !crossesDeadline(snapshot.now.getTime(), now.getTime())) return;
		snapshot = { now, timezone };
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
				const published = snapshot.now.getTime();
				let passedSincePublished = false;
				for (const deadline of values) {
					if (deadline >= now && deadline + 1 < scheduledAt) setTimer(deadline + 1, now);
					if (deadline >= published && deadline <= now) passedSincePublished = true;
				}
				// The published time can be older than a minute. A new deadline
				// between it and now must not render as still pending.
				if (passedSincePublished) update();
			}
			return () => { deadlines.delete(key); };
		},
	};
}
