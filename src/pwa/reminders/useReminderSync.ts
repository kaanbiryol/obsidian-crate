import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { capturePwaSession } from '../connection/session-generation';
import { EncryptionKeyRequiredError } from '../encryption/encryption-onboarding';
import { reminderEncryptionSnapshot } from './encryption-session';
import { fetchReadyReminderList, type ReminderIndexingProgress } from './reminder-api';
import { loadCachedReminderSnapshot, rebuildCachedReminderSnapshot, refreshCachedReminderSnapshot, saveCachedReminderSnapshot } from './cache/reminder-cache';
import { createReminderRequestCoordinator } from './outbox/reminder-request-coordinator';
import { createReminderListCursor } from './reminder-list-cursor';
import { beginStartupRead, reusableStartupRead, startupReadKey, takeStartupResponse, type StartupRead } from './startup-reminder-read';
import { decideReminderListFailure, decideReminderListResponse, needsDiskFallback } from './reminder-list-response';
import { requestSharedFeaturesRefresh } from '../shared-features';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { responseError } from '../connection/response-error';
import type { ApiFetch, DataMode, StoredConfig } from '../types';
import type { CachedReminderSnapshot, ReminderRecord, ReminderSourceIssue, ReminderSyncHost } from './types';

interface ConfirmedReminderSnapshot {
	reminders: ReminderRecord[];
	projects: string[];
}

export interface ReminderSyncState extends ReminderSyncHost {
	reminders: ReminderRecord[];
	projects: string[];
	loading: boolean;
	refreshing: boolean;
	indexingProgress: ReminderIndexingProgress | null;
	error: string | null;
	issues: ReminderSourceIssue[];
	dataMode: DataMode;
	lastUpdatedAt: number | null;
	isOffline: boolean;
	/** Startup hydration finished for the current connection, whether or not an offline copy existed. */
	hydrated: boolean;
	getSnapshot: () => ConfirmedReminderSnapshot;
	hasHydratedCache: () => boolean;
	hydrateCachedSnapshot: (snapshot: CachedReminderSnapshot) => void;
	rebuildOfflineCache: () => Promise<void>;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[], options?: { persist?: boolean | 'later' }) => Promise<void>;
	persistReminderState: () => Promise<void>;
	resetReminderState: () => void;
	refreshPresentation: () => void;
	reportError: (message: string | null) => void;
}

export function useReminderSync({
	apiFetch,
	readUnverified,
	authToken,
	authority,
	bootstrapped,
	config,
	prepareSession,
	onSignedOut,
	setSelectedProject,
	enabled = true,
}: {
	enabled?: boolean;
	apiFetch: ApiFetch;
	/** Sends a read before the startup encryption check answers; see startup reads below. */
	readUnverified?: ApiFetch;
	authToken: string | null;
	/** Identifies the app connection whose offline copy is hydrated. */
	authority: object;
	/** App startup finished, so the offline copy can be read. */
	bootstrapped: boolean;
	config: StoredConfig;
	prepareSession: () => Promise<void>;
	/** Resets presentation outside this hook when no session remains. */
	onSignedOut: () => void;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
}): ReminderSyncState {
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;
	const [snapshot, setSnapshot] = useState<ConfirmedReminderSnapshot>({ reminders: [], projects: [] });
	const { reminders, projects } = snapshot;
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [indexingProgress, setIndexingProgress] = useState<ReminderIndexingProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [dataMode, setDataMode] = useState<DataMode>('live');
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
	// A confirmed response shows the server is reachable while the browser still reports
	// offline, until the browser's next online or offline event.
	const [answered, setAnswered] = useState(false);
	const isOffline = !useOnlineStatus(() => setAnswered(false)) && !answered;
	const [issues, setIssues] = useState<ReminderSourceIssue[]>([]);
	const [hydratedAuthority, setHydratedAuthority] = useState<object | null>(null);
	const issuesRef = useRef<ReminderSourceIssue[]>([]);
	const snapshotRef = useRef(snapshot);
	const hydratedCacheRef = useRef(false);
	const requestCoordinatorRef = useRef(createReminderRequestCoordinator());
	const [cursor] = useState(createReminderListCursor);
	const activeReadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
	const startupRef = useRef<StartupRead | null>(null);
	const startupStartedRef = useRef(false);

	useEffect(() => {
		if (startupStartedRef.current || bootstrapped) return;
		startupStartedRef.current = true;
		if (!authToken || !readUnverified || !enabledRef.current) return;
		startupRef.current = beginStartupRead(config.folderPath, authToken, readUnverified);
	}, [bootstrapped, authToken, readUnverified, config.folderPath]);

	const lifetimeRef = useRef({ active: true });
	useEffect(() => {
		const lifetime = { active: true };
		lifetimeRef.current = lifetime;
		setIndexingProgress(null);
		return () => {
			lifetime.active = false;
			activeReadRef.current = null;
		};
	}, [apiFetch, authToken, config.folderPath]);

	const getSnapshot = useCallback(() => snapshotRef.current, []);
	const publishSnapshot = useCallback((reminders: ReminderRecord[], projects = snapshotRef.current.projects) => {
		snapshotRef.current = { reminders, projects };
		setSnapshot(snapshotRef.current);
		setSelectedProject(current => current && !projects.includes(current) ? null : current);
	}, [setSelectedProject]);
	const hasHydratedCache = useCallback(() => hydratedCacheRef.current, []);
	const refreshPresentation = useCallback(() => publishSnapshot([...snapshotRef.current.reminders]), [publishSnapshot]);

	// Confirmed state committed with persist: 'later' that the offline copy does not hold yet.
	const unsavedRef = useRef<{ folderPath: string; savedAt: number } | null>(null);
	const commitConfirmedSnapshot = useCallback(async (nextReminders: ReminderRecord[], nextProjects = snapshotRef.current.projects,
		{ etag, deltaBase, persist = true }: { etag?: string; deltaBase?: string; persist?: boolean | 'later' } = {}) => {
		const savedAt = Date.now();
		publishSnapshot(nextReminders, nextProjects);
		cursor.confirmed({ etag, deltaBase }, savedAt);
		setLastUpdatedAt(savedAt);
		setDataMode('live');
		setAnswered(true);
		if (persist === 'later') { unsavedRef.current = { folderPath: config.folderPath, savedAt }; return; }
		if (!persist) return;
		unsavedRef.current = null;
		await saveCachedReminderSnapshot({ folderPath: config.folderPath, reminders: nextReminders, projects: nextProjects,
			savedAt, etag, issues: issuesRef.current, deltaBase: cursor.deltaBase });
	}, [config.folderPath, cursor, publishSnapshot]);
	const commitReminderState = useCallback((nextReminders: ReminderRecord[], nextProjects?: string[], options?: { persist?: boolean | 'later' }) =>
		commitConfirmedSnapshot(nextReminders, nextProjects, { persist: options?.persist }), [commitConfirmedSnapshot]);
	/** One offline-copy write for the confirmed results of a whole outbox drain. The
	 * durable outbox keeps each command until the server confirms it, so a lost
	 * write only leaves an older confirmed copy that the next delta read repairs. */
	const persistReminderState = useCallback(async () => {
		const unsaved = unsavedRef.current;
		if (!unsaved || unsaved.folderPath !== config.folderPath) return;
		unsavedRef.current = null;
		const { reminders: nextReminders, projects: nextProjects } = snapshotRef.current;
		await saveCachedReminderSnapshot({ folderPath: config.folderPath, reminders: nextReminders, projects: nextProjects,
			savedAt: unsaved.savedAt, etag: cursor.persistedEtag, issues: issuesRef.current, deltaBase: cursor.deltaBase });
	}, [config.folderPath, cursor]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		hydratedCacheRef.current = true;
		unsavedRef.current = null;
		setLoading(false);
		publishSnapshot(snapshot.reminders, snapshot.projects);
		issuesRef.current = snapshot.issues ?? [];
		setIssues(issuesRef.current);
		cursor.hydrate(snapshot);
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
	}, [cursor, publishSnapshot]);

	const takeStartupRead = useCallback((key: string, path: string, headers: Headers): Promise<Response | undefined> => {
		const startup = startupRef.current;
		startupRef.current = null;
		return takeStartupResponse(startup, key, path, headers, apiFetch);
	}, [apiFetch]);

	const loadReminders = useCallback((options: { silent?: boolean; maxAgeMs?: number } = {}) => {
		if (!authToken || !enabledRef.current) return Promise.resolve();
		if (cursor.isFresh(options.maxAgeMs)) return Promise.resolve();

		const requestKey = startupReadKey(config.folderPath, authToken);
		if (activeReadRef.current?.key === requestKey) return activeReadRef.current.promise;
		requestSharedFeaturesRefresh();

		const promise = (async () => {
			const session = capturePwaSession();
			const lifetime = lifetimeRef.current;
			const sessionCurrent = () => lifetime.active && session();
			if (!sessionCurrent()) return;
			const readToken = requestCoordinatorRef.current.beginRead();
			// A local change, an invalidation or a newer read leaves this one unusable for good.
			const readApplies = () => sessionCurrent() && requestCoordinatorRef.current.shouldApplyRead(readToken);
			if (options.silent) setRefreshing(true);
			else setLoading(true);
			setError(null);
			setIndexingProgress(null);
			try {
				const { path, headers, since } = cursor.request(config.folderPath, issuesRef.current.length === 0);
				const response = await fetchReadyReminderList(
					apiFetch,
					path,
					headers,
					(remaining, total) => {
						if (readApplies()) setIndexingProgress({ indexedFiles: Math.max(0, total - remaining), totalFiles: total });
					},
					// Only the first read after startup waits here; others dispatch at once.
					startupRef.current ? await takeStartupRead(requestKey, path, headers) : undefined,
					readApplies,
				);
				if (response.status !== 304 && !response.ok) throw new Error((await responseError(response, 'Could not load reminders.')).message);
				const body: unknown = response.status === 304 ? undefined : await response.json().catch(() => null);
				if (!readApplies()) return;
				const outcome = decideReminderListResponse({ status: response.status, headers: response.headers, body },
					{ folderPath: config.folderPath, confirmed: snapshotRef.current.reminders, since, lastCheckedAt: cursor.lastCheckedAt });
				if (outcome.kind === 'not-modified') {
					const savedAt = Date.now();
					cursor.notModified(response.headers, savedAt);
					setLastUpdatedAt(savedAt);
					setDataMode('live');
					setAnswered(true);
					void refreshCachedReminderSnapshot(
						config.folderPath,
						savedAt,
						cursor.persistedEtag,
					);
					return;
				}
				if (outcome.dropDeltaBase) cursor.dropDeltaBase();
				if (outcome.kind === 'invalid') {
					setError(outcome.message);
					if (outcome.showErrorState) setDataMode('error');
					return;
				}
				setError(null);
				issuesRef.current = outcome.result.issues;
				setIssues(outcome.result.issues);
				void commitConfirmedSnapshot(outcome.result.reminders, outcome.result.projects, { etag: outcome.etag, deltaBase: outcome.deltaBase });
			} catch (loadError) {
				if (!readApplies()) return;
				const cached = needsDiskFallback(cursor.lastCheckedAt) ? await loadCachedReminderSnapshot(config.folderPath) : undefined;
				if (!readApplies()) return;
				const outcome = decideReminderListFailure(loadError, { lastCheckedAt: cursor.lastCheckedAt, cached });
				if (outcome.kind === 'keep-stale') setDataMode('cached');
				else if (outcome.kind === 'hydrate-cache') hydrateCachedSnapshot(outcome.cached);
				else setDataMode('error');
				setError(outcome.message);
			} finally {
				if (sessionCurrent() && requestCoordinatorRef.current.isLatestRead(readToken)) {
					setIndexingProgress(null);
					setRefreshing(false);
					setLoading(false);
				}
			}
		})();

		activeReadRef.current = { key: requestKey, promise };
		const clearActiveRead = () => {
			if (activeReadRef.current?.promise === promise) activeReadRef.current = null;
		};
		void promise.then(clearActiveRead, clearActiveRead);
		return promise;
	}, [apiFetch, authToken, config.folderPath, cursor, hydrateCachedSnapshot, commitConfirmedSnapshot, takeStartupRead]);

	const rebuildOfflineCache = useCallback(async () => {
		startupRef.current = null;
		const sessionCurrent = capturePwaSession();
		if (!await rebuildCachedReminderSnapshot(config.folderPath) || !sessionCurrent()) return;
		cursor.forgetServerPosition();
		activeReadRef.current = null;
		await loadReminders({ silent: true });
	}, [config.folderPath, cursor, loadReminders]);

	const invalidateReads = useCallback(() => {
		requestCoordinatorRef.current.invalidateReads();
		activeReadRef.current = null;
		setIndexingProgress(null);
	}, []);

	const beginLocalMutation = useCallback(() => {
		const coordinator = requestCoordinatorRef.current;
		const finish = coordinator.beginMutation();
		activeReadRef.current = null;
		setIndexingProgress(null);
		return () => {
			finish();
			// A refresh after acknowledgement must not join a read invalidated by this write.
			if (requestCoordinatorRef.current === coordinator) activeReadRef.current = null;
		};
	}, []);


	const resetReminderState = useCallback(() => {
		requestCoordinatorRef.current = createReminderRequestCoordinator();
		unsavedRef.current = null;
		startupRef.current = null;
		publishSnapshot([], []);
		issuesRef.current = [];
		setIssues([]);
		hydratedCacheRef.current = false;
		activeReadRef.current = null;
		setLoading(false);
		setRefreshing(false);
		setIndexingProgress(null);
		setLastUpdatedAt(null);
		cursor.reset();
	}, [cursor, publishSnapshot]);

	useEffect(() => {
		if (!bootstrapped) return;
		let cancelled = false;
		const current = capturePwaSession();
		void (async () => {
			try {
				if (!authToken) { onSignedOut(); resetReminderState(); return; }
				// Startup's check got no answer on a device without encryption evidence:
				// show the plaintext copy now. Storage stays locked; the next refresh retries.
				const view = reminderEncryptionSnapshot();
				if (!(view.status === 'locked' && view.offlineCopy)) await prepareSession();
				const startup = reusableStartupRead(startupRef.current, startupReadKey(config.folderPath, authToken));
				if (!startup) startupRef.current = null;
				const cached = await (startup?.cached ?? loadCachedReminderSnapshot(config.folderPath));
				if (!cancelled && current() && cached) hydrateCachedSnapshot(cached);
			} catch (cause) {
				if (!cancelled && current() && !(cause instanceof EncryptionKeyRequiredError)) setError(cause instanceof Error ? cause.message : String(cause));
			} finally { if (!cancelled) setHydratedAuthority(authority); }
		})();
		return () => { cancelled = true; };
	}, [bootstrapped, authority, authToken, prepareSession, config.folderPath, hydrateCachedSnapshot, onSignedOut, resetReminderState]);

	return {
		reminders,
		projects,
		loading,
		refreshing,
		indexingProgress,
		error,
		issues,
		dataMode,
		lastUpdatedAt,
		isOffline,
		hydrated: hydratedAuthority === authority,
		getSnapshot,
		hasHydratedCache,
		hydrateCachedSnapshot,
		rebuildOfflineCache,
		loadReminders,
		beginLocalMutation,
		invalidateReads,
		commitReminderState,
		persistReminderState,
		resetReminderState,
		refreshPresentation,
		reportError: setError,
	};
}
