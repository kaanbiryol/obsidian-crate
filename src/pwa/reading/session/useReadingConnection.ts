import { EncryptionTransitionError, EncryptionVerificationUnavailableError } from '../../connection/encryption';
import { connectionIssue, SESSION_RECOVERY_ISSUE, type ConnectionIssue } from '../../connection/issues';
import { EncryptionKeyRequiredError } from '../../encryption/encryption-onboarding';
import { resetReadingEncryption } from './encryption-lifecycle';
import { prepareReadingEncryption } from './encryption-session';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT } from '../../config';
import { connectReadingFromReminders } from '../api';
import { readingConnectionState, type ReadingConnectionState } from './api-error';
import { READING_SESSION_KEY, assertReadingSession, readingSession, type ReadingSession } from './session';

/** App-owned Reading connection; no article, draft or queue hydration. */
export function useReadingConnection(enabled: boolean, startupReady: boolean, authority?: object) {
	const [session, setSession] = useState<ReadingSession | null>(null);
	const [converting, setConverting] = useState(false);
	const [encryptionSetupRequired, setEncryptionSetupRequired] = useState(false);
	const [lockedSession, setLockedSession] = useState<ReadingSession | null>(null);
	const [verificationUnavailable, setVerificationUnavailable] = useState(false);
	// No answer and no encryption evidence: the plaintext offline copy is shown read-only.
	const [offlineCopy, setOfflineCopy] = useState(false);
	const [ready, setReady] = useState(false), [connecting, setConnecting] = useState(false);
	const [issue, setIssue] = useState<ConnectionIssue | null>(null);
	const [connectionState, setConnectionState] = useState<ReadingConnectionState>('available');
	const alive = useRef(true), connectingRef = useRef(false), generation = useRef(0);
	const run = useCallback(async (action: () => Promise<void>) => {
		const revision = generation.current;
		try { await action(); } catch (cause) {
			if (alive.current && revision === generation.current) setIssue(connectionIssue(cause));
		}
	}, []);
	const resetSession = useCallback(() => {
		generation.current++; resetReadingEncryption();
		setSession(null); setLockedSession(null); setVerificationUnavailable(false); setOfflineCopy(false); setEncryptionSetupRequired(false); setConverting(false);
	}, []);
	const expire = useCallback(() => { resetSession(); setIssue(SESSION_RECOVERY_ISSUE); }, [resetSession]);
	const hydrate = useCallback(async (current: ReadingSession) => {
		const revision = generation.current;
		const currentRequest = () => {
			assertReadingSession(current);
			return alive.current && revision === generation.current;
		};
		if (!currentRequest()) return;
		try { await prepareReadingEncryption(current); } catch (cause) {
			if (!currentRequest()) return;
			setConverting(cause instanceof EncryptionTransitionError);
			setEncryptionSetupRequired(cause instanceof EncryptionKeyRequiredError && cause.firstUnlock);
			setVerificationUnavailable(cause instanceof EncryptionVerificationUnavailableError);
			setOfflineCopy(cause instanceof EncryptionVerificationUnavailableError && cause.offlineCopy);
			setLockedSession(current); setIssue(connectionIssue(cause)); return;
		}
		if (!currentRequest()) return;
		setLockedSession(null); setVerificationUnavailable(false); setOfflineCopy(false); setEncryptionSetupRequired(false); setConverting(false);
		setSession(current); setIssue(null);
		return true;
	}, []);
	const connect = useCallback(async () => {
		if (!startupReady || !enabled || connectingRef.current || !navigator.onLine || !localStorage.getItem(AUTH_TOKEN_KEY)) return;
		const revision = generation.current;
		connectingRef.current = true; setConnecting(true);
		try {
			const next = (await connectReadingFromReminders())?.session;
			if (!alive.current || revision !== generation.current || !next) return;
			setIssue(null); setConnectionState('available');
			await hydrate(next);
		} catch (cause) {
			if (alive.current && revision === generation.current) {
				setConnectionState(readingConnectionState(cause));
				setIssue(connectionIssue(cause));
			}
		} finally { connectingRef.current = false; if (alive.current) setConnecting(false); }
	}, [startupReady, enabled, hydrate]);
	useEffect(() => {
		if (!startupReady) return;
		alive.current = true;
		let cancelled = false;
		const lifetime = generation;
		void run(async () => {
			try {
				const current = readingSession();
				if (current) await hydrate(current);
			} finally { if (!cancelled) setReady(true); }
		});
		return () => { cancelled = true; alive.current = false; lifetime.current++; };
	}, [startupReady, authority, run, hydrate]);
	useEffect(() => {
		if (!startupReady || !ready || session || lockedSession) return;
		const changed = (event: StorageEvent) => { if (event.key === AUTH_TOKEN_KEY || event.key === READING_SESSION_KEY || event.key === null) void connect(); };
		const retry = () => { void connect(); };
		const resume = () => { if (document.visibilityState === 'visible') retry(); };
		window.addEventListener('online', retry); window.addEventListener('pageshow', retry);
		window.addEventListener('storage', changed); window.addEventListener(PWA_AUTH_CHANGED_EVENT, retry);
		document.addEventListener('visibilitychange', resume);
		retry();
		return () => {
			window.removeEventListener('online', retry); window.removeEventListener('pageshow', retry);
			window.removeEventListener('storage', changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, retry);
			document.removeEventListener('visibilitychange', resume);
		};
	}, [startupReady, ready, session, lockedSession, connect]);
	const retryVerification = useCallback(async () => {
		if (lockedSession && verificationUnavailable) await run(async () => { await hydrate(lockedSession); });
	}, [lockedSession, verificationUnavailable, run, hydrate]);
	useEffect(() => {
		// An unavailable check retries in place, like Reminders' foreground refresh.
		if (!lockedSession || !verificationUnavailable) return;
		const retry = () => { void retryVerification(); };
		const resume = () => { if (document.visibilityState === 'visible') retry(); };
		window.addEventListener('online', retry); window.addEventListener('pageshow', retry);
		document.addEventListener('visibilitychange', resume);
		return () => {
			window.removeEventListener('online', retry); window.removeEventListener('pageshow', retry);
			document.removeEventListener('visibilitychange', resume);
		};
	}, [lockedSession, verificationUnavailable, retryVerification]);
	return { session, lockedSession, verificationUnavailable, offlineCopy, retryVerification, encryptionSetupRequired, converting, expire, ready, connecting, connect, resetSession, issue, error: issue?.message ?? null, connectionState };
}

export type ReadingConnection = ReturnType<typeof useReadingConnection>;
