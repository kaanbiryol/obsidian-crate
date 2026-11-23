import { drainReading, readingRetryAt, type ReadingRetryMode } from './outbox';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT, PWA_LOGOUT_KEY } from '../config';
import { loadReading } from './api';
import { connectReadingFromReminders } from './session/reminders-session';
import { pendingReading, readingLock, type ReadingCache } from './storage/storage';
import { assertReadingSession, READING_CHANGED_EVENT, readingSession, READING_SESSION_KEY, sameReadingSession, type ReadingSession } from './session/session';
import type { useReadingSession } from './useReadingSession';
import { requestSharedFeaturesRefresh } from '../shared-features';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { FOREGROUND_REFRESH_GAP_MS, onAppResume, type AppResumeReason } from '../shell/app-resume';

// A saved link's article usually arrives seconds after the save. The list checks back this
// long after it first lists the link as fetching, then waits for the next foreground.
const FETCH_CHECKS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 80_000];
// Links saved longer ago than this are not watched, so an article that never arrives
// costs no checks when the app opens.
const FETCH_WATCH_AGE_MS = 10 * 60_000;

/** When the list next checks on a link it first listed as fetching at `since`, or Infinity. */
export function nextFetchCheck(since: number, now: number): number {
	for (const delay of FETCH_CHECKS_MS) if (since + delay > now) return since + delay;
	return Infinity;
}

/** Owns refresh serialization, bounded retries and foreground/cross-tab refresh. */
export function useReadingSync({ session, ready, readOnly, cache, pending, publishSyncResult, reportLibraryFailure, isCurrentSession, run, resetSession, retryVerification }: Pick<ReturnType<typeof useReadingSession>,
	'session' | 'ready' | 'readOnly' | 'cache' | 'pending' | 'publishSyncResult' | 'reportLibraryFailure' | 'isCurrentSession' | 'run' | 'resetSession' | 'retryVerification'>, enabled = true) {
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;
	const [syncing, setSyncing] = useState(false), [syncedSession, setSyncedSession] = useState<ReadingSession | null>(null);
	const isOffline = !useOnlineStatus(() => setSyncedSession(null));
	const refreshing = useRef(false), refreshQueued = useRef<{ session: ReadingSession; mode: ReadingRetryMode } | null>(null);
	const completedAt = useRef<{ session: ReadingSession; at: number } | null>(null);
	const refresh = useCallback(async (current = session, mode: ReadingRetryMode = 'automatic') => {
		if (!current || !enabledRef.current || !isCurrentSession(current)) return;
		// A read-only offline copy waits for an answered encryption check; nothing is sent.
		if (readOnly) { await retryVerification(); return; }
		if (refreshing.current) {
			const queued = refreshQueued.current;
			const sameSession = sameReadingSession(queued?.session, current);
			refreshQueued.current = { session: current, mode: sameSession && queued?.mode === 'manual' ? 'manual' : mode };
			return;
		}
		refreshing.current = true; setSyncing(true); setSyncedSession(null);
		requestSharedFeaturesRefresh();
		try {
			// Enrollment checks share the refresh lock. Foreground and cross-tab
			// events can arrive together while the previous check is still pending.
			let verified: { day: number; generation: string } | undefined;
			if (navigator.onLine) {
				const connected = await connectReadingFromReminders();
				if (!isCurrentSession(current)) return;
				if (!sameReadingSession(connected?.session, current)) {
					resetSession(); return;
				}
				if (!enabledRef.current) return;
				// The drain reuses this check instead of reading the session again.
				if (connected?.day !== undefined) verified = { day: connected.day, generation: current.generation };
			}
			let data: ReadingCache | undefined;
			let completed = false;
			try {
				const confirmed = await drainReading(current, mode, () => enabledRef.current, verified);
				if (confirmed) data = confirmed;
				else if (navigator.onLine && enabledRef.current) {
					data = await loadReading(current);
				// Offline, nothing of the library is stored: the app lists saved articles instead.
				} else data = { items: [], issues: [], savedAt: Date.now(), offline: true };
				completed = true;
			} finally {
				// Publish the latest durable queue even when refreshing the list fails.
				// Queue edits and this read share a lock so a stale refresh cannot hide new work.
				await readingLock(async () => {
					const work = await pendingReading(current);
					assertReadingSession(current);
					if (!publishSyncResult(current, { pending: work, cache: data, completed })) return;
					if (completed && enabledRef.current && navigator.onLine && data) { setSyncedSession(current); completedAt.current = { session: current, at: Date.now() }; }
				});
			}
		} catch (cause) {
			// The library keeps its saved list and banner until a refresh succeeds.
			reportLibraryFailure(current);
			throw cause;
		} finally {
			refreshing.current = false;
			setSyncing(false);
			const queued = refreshQueued.current;
			refreshQueued.current = null;
			if (queued && isCurrentSession(queued.session)) void run(() => refresh(queued.session, queued.mode));
		}
	}, [session, readOnly, run, isCurrentSession, publishSyncResult, reportLibraryFailure, resetSession, retryVerification]);
	const retryAt = Math.min(...pending.map(op => readingRetryAt(op) ?? Infinity));
	useEffect(() => {
		if (!enabled || !session || !ready || readOnly || isOffline || !Number.isFinite(retryAt)) return;
		// Match Reminders' short, bounded retries for interrupted requests. Their
		// exact persisted bodies remain authoritative until a receipt is confirmed.
		// Subscribe to the deadline, not queue object identity: a failed session/list
		// read must not repeatedly reschedule an already elapsed retry.
		const timer = window.setTimeout(() => { void run(() => refresh(session)); }, Math.max(0, retryAt - Date.now()));
		return () => window.clearTimeout(timer);
	}, [enabled, session, ready, readOnly, isOffline, retryAt, refresh, run]);
	// Links being fetched, by when the list first showed each as fetching.
	const fetching = useRef(new Map<string, number>());
	useEffect(() => {
		if (!enabled || !session || !ready || readOnly || isOffline) return;
		const listed = new Set<string>();
		for (const item of cache?.items ?? []) {
			if (item.extraction_status !== 'pending' || !(Date.now() - Date.parse(item.saved_at) <= FETCH_WATCH_AGE_MS)) continue;
			listed.add(item.crate_reading_id);
			if (!fetching.current.has(item.crate_reading_id)) fetching.current.set(item.crate_reading_id, Date.now());
		}
		for (const id of fetching.current.keys()) if (!listed.has(id)) fetching.current.delete(id);
		let timer: number | undefined;
		const schedule = () => {
			const now = Date.now(), due = Math.min(...[...fetching.current.values()].map(since => nextFetchCheck(since, now)));
			if (!Number.isFinite(due)) return;
			timer = window.setTimeout(() => {
				// A hidden app checks again when it returns to the foreground.
				if (document.visibilityState === 'visible') void run(() => refresh(session));
				schedule();
			}, due - now);
		};
		schedule();
		return () => window.clearTimeout(timer);
	}, [enabled, session, ready, readOnly, isOffline, cache, refresh, run]);
	useEffect(() => {
		if (!session || !ready) return;
		const reload = () => { if (enabledRef.current && document.visibilityState === 'visible') void run(() => refresh(session)); };
		// Foregrounding during or shortly after a refresh reuses it, like Reminders. One
		// resume can fire both pageshow and visibilitychange; reconnecting always reloads.
		const resume = (reason: AppResumeReason) => {
			const completed = completedAt.current;
			if (reason === 'foreground' && (refreshing.current || completed?.session === session && Date.now() - completed.at < FOREGROUND_REFRESH_GAP_MS)) return;
			reload();
		};
		const changed = () => {
			let current: ReadingSession | null;
			try { current = readingSession(); } catch (cause) {
				resetSession(cause instanceof Error ? cause.message : 'Reading sign-in could not be read. Reconnect from Obsidian settings.');
				return;
			}
			if (!sameReadingSession(current, session)) resetSession();
			else reload();
		};
		const storageChanged = (event: StorageEvent) => {
			if (event.key === AUTH_TOKEN_KEY || event.key === READING_SESSION_KEY || event.key === PWA_LOGOUT_KEY || event.key === null) changed();
		};
		// A read-only copy appears after its encryption check just failed.
		if (!readOnly) reload();
		// Refresh on open, foreground, reconnect and explicit refresh; on a timer only to retry
		// queued changes or to check on a link being fetched.
		const stopResume = onAppResume(resume);
		window.addEventListener('storage', storageChanged); window.addEventListener(READING_CHANGED_EVENT, changed); window.addEventListener(PWA_AUTH_CHANGED_EVENT, changed);
		return () => { stopResume(); window.removeEventListener('storage', storageChanged); window.removeEventListener(READING_CHANGED_EVENT, changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, changed); };
	}, [enabled, session, ready, readOnly, refresh, run, resetSession]);
	const refreshManually = useCallback(() => refresh(session, 'manual'), [refresh, session]);
	return { refresh, refreshManually, syncing, syncedSession, isOffline, retryAt };
}
