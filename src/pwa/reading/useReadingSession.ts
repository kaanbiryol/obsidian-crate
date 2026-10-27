import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingConnection } from './session/useReadingConnection';
import type { PendingReading } from './outbox';
import { adoptEarlierReadingCaptures, hasEarlierReadingChanges, newestReadingShare, pendingReading, readReadingCache, readReadingDraft, readReadingShare, removeReadingShare, saveReadingDraft, type ReadingCache } from './storage/storage';
import { assertReadingSession, type ReadingSession } from './session/session';
import { sameReadingSession } from './session/session';

interface ReadingSyncPublication {
	pending: PendingReading[];
	cache?: ReadingCache;
	completed: boolean;
}

/** Feature-owned durable hydration. Authentication and unlocking belong to the app. */
export function useReadingSession(connection: ReadingConnection) {
	const [session, setSession] = useState<ReadingSession | null>(null);
	const [hydrated, setHydrated] = useState<ReadingSession | null>(null);
	const [cache, setCache] = useState<ReadingCache | null>(null), [pending, setPending] = useState<PendingReading[]>([]);
	const [error, setError] = useState<string | null>(null), [storageError, setStorageError] = useState<string | null>(null);
	const [recovery, setRecovery] = useState(false), [draftReady, setDraftReady] = useState(false);
	const [adding, setAdding] = useState(false), [url, setUrl] = useState('');
	const alive = useRef(true), generation = useRef(0);
	const authority = useRef<ReadingSession | null>(null);
	const isCurrentSession = useCallback((expected: ReadingSession) => {
		if (!alive.current || !sameReadingSession(authority.current, expected)) return false;
		try { assertReadingSession(expected); return true; } catch { return false; }
	}, []);
	const publishPending = useCallback((expected: ReadingSession, next: PendingReading[]) => {
		if (!isCurrentSession(expected)) return false;
		setPending(next);
		return true;
	}, [isCurrentSession]);
	const publishSyncResult = useCallback((expected: ReadingSession, result: ReadingSyncPublication) => {
		if (!isCurrentSession(expected)) return false;
		if (result.cache) setCache(result.cache);
		setPending(result.pending);
		if (result.completed) setError(null);
		return true;
	}, [isCurrentSession]);
	const refreshRecovery = useCallback(async () => {
		const expected = authority.current;
		const earlier = await hasEarlierReadingChanges(expected?.id);
		if (alive.current && (!expected || isCurrentSession(expected))) setRecovery(earlier);
	}, [isCurrentSession]);
	const reportSessionError = useCallback((expected: ReadingSession, message: string | null) => {
		if (isCurrentSession(expected)) setError(message);
	}, [isCurrentSession]);
	const finishCapture = useCallback((expected: ReadingSession) => {
		if (!isCurrentSession(expected)) return false;
		setUrl('');
		return true;
	}, [isCurrentSession]);
	const openCapture = useCallback(() => { setError(null); setAdding(true); }, []);
	const closeCapture = useCallback(() => setAdding(false), []);
	const run = useCallback(async (action: () => Promise<void>) => {
		const revision = generation.current;
		try { await action(); } catch (cause) {
			if (alive.current && revision === generation.current) setError(cause instanceof Error ? cause.message : 'Reading is unavailable.');
		}
	}, []);
	const resetConnection = connection.resetSession;
	const resetSession = useCallback((message?: string) => {
		generation.current++; authority.current = null; resetConnection();
		setSession(null); setHydrated(null); setCache(null); setPending([]); setDraftReady(false); setStorageError(null);
		setUrl(''); setAdding(false);
		if (message) setError(message);
	}, [resetConnection]);
	// An unanswered check on a device without encryption evidence shows the plaintext
	// offline copy. Storage refuses writes, so drafts, shares and sends wait for a check.
	const readOnly = !connection.session && connection.offlineCopy;
	const target = connection.session ?? (readOnly ? connection.lockedSession : null);
	useEffect(() => {
		// A null session during unlock is not a disconnected session. Scanning here
		// treats this session's encrypted queue as unreadable earlier-session work.
		if (!connection.ready || connection.connecting || (connection.lockedSession && !readOnly)) return;
		alive.current = true;
		const lifetime = generation;
		const revision = ++lifetime.current;
		const current = target;
		authority.current = current;
		setSession(null); setHydrated(null); setCache(null); setPending([]); setDraftReady(false); setStorageError(null);
		setUrl(''); setAdding(false); setError(null);
		const currentRequest = () => {
			if (!alive.current || revision !== generation.current) return false;
			if (current) assertReadingSession(current);
			return true;
		};
		void run(async () => {
			if (!current) {
				const earlier = await hasEarlierReadingChanges();
				if (currentRequest()) setRecovery(earlier);
				return;
			}
			// A read-only copy cannot write; otherwise unsent captures of an earlier sign-in
			// join this queue first. A failure leaves them for review and export.
			if (!readOnly) await adoptEarlierReadingCaptures(current).catch(() => {});
			if (!currentRequest()) return;
			// Read each lifetime separately: a disposable cache failure must not hide a
			// saved draft, and an unreadable draft must never be replaced by empty input.
			const results = await Promise.allSettled([
				readReadingCache(current), pendingReading(current), readReadingDraft(current), hasEarlierReadingChanges(current.id),
			]);
			if (!currentRequest()) return;
			const [saved, work, draft, earlier] = results;
			setCache(saved.status === 'fulfilled' ? saved.value ?? null : null);
			setPending(work.status === 'fulfilled' ? work.value : []);
			setRecovery(earlier.status === 'fulfilled' ? earlier.value : true);
			if (saved.status === 'rejected') setError(saved.reason instanceof Error ? saved.reason.message : 'The saved Reading library could not be read.');
			const failure = [work, draft, earlier].find(result => result.status === 'rejected');
			if (failure?.status === 'rejected') {
				setStorageError(failure.reason instanceof Error ? failure.reason.message : 'Reading storage could not be read. Export your Reading data before changing browser storage.');
				setRecovery(true);
			}
			setSession(current);
			if (draft.status === 'fulfilled' && !readOnly) {
				if (draft.value?.url) { setUrl(draft.value.url); setAdding(true); }
				setDraftReady(true);
			}

			if (!currentRequest()) return;
			setHydrated(current);
			if (readOnly || draft.status !== 'fulfilled') return;
			// A staged share leaves storage once its link is in this session's draft, so
			// a dismissed form cannot strand it. Without `?share=`, for example after an
			// enrollment link replaced the URL, take the newest one unless the draft has a link.
			const shareId = new URL(location.href).searchParams.get('share');
			const staged = shareId ? await readReadingShare(shareId).then(share => share && { id: shareId, url: share.url })
				: draft.value?.url ? undefined : await newestReadingShare().catch(() => undefined);
			if (!staged || !currentRequest()) return;
			setUrl(staged.url); setAdding(true);
			await saveReadingDraft(current, { url: staged.url });
			await removeReadingShare(current, staged.id);
		});
		return () => { alive.current = false; authority.current = null; lifetime.current++; };
	}, [target, readOnly, connection.ready, connection.connecting, connection.lockedSession, run]);
	const ready = connection.ready && (!target || hydrated === target || Boolean(error));
	useEffect(() => {
		if (session && ready && draftReady) void run(() => saveReadingDraft(session, { url }));
	}, [session, ready, draftReady, url, run]);
	return { ...connection, session, readOnly, ready, resetSession, cache, pending,
		error: storageError ?? error ?? connection.error, recovery, adding, url, setUrl, run,
		isCurrentSession, publishPending, publishSyncResult, refreshRecovery, reportSessionError, finishCapture, openCapture, closeCapture };
}
