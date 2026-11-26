import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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
import { initialReminderSyncState, reduceReminderSync, type ConfirmedReminderSnapshot } from './reminder-sync-state';

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
	const [state, dispatch] = useReducer(reduceReminderSync, undefined, initialReminderSyncState);
	const { snapshot: { reminders, projects }, loading, refreshing, indexingProgress, error, issues, dataMode, lastUpdatedAt } = state;
	// Counts the browser's online and offline events, so a response knows whether its request
	// was sent under the current connection.
	const connectivityRef = useRef(0);
	const isOffline = !useOnlineStatus(() => { connectivityRef.current += 1; dispatch({ type: 'connectivity-changed' }); }) && !state.answered;
	const issuesRef = useRef<ReminderSourceIssue[]>([]);
	const snapshotRef = useRef(state.snapshot);
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
		dispatch({ type: 'reads-detached' });
		return () => {
			lifetime.active = false;
			activeReadRef.current = null;
		};
	}, [apiFetch, authToken, config.folderPath]);

	const getSnapshot = useCallback(() => snapshotRef.current, []);
	/** Updates the confirmed snapshot for synchronous readers; the caller's event renders it. */
	const publishSnapshot = useCallback((reminders: ReminderRecord[], projects = snapshotRef.current.projects): ConfirmedReminderSnapshot => {
		snapshotRef.current = { reminders, projects };
		setSelectedProject(current => current && !projects.includes(current) ? null : current);
		return snapshotRef.current;
	}, [setSelectedProject]);
	const hasHydratedCache = useCallback(() => hydratedCacheRef.current, []);
	const refreshPresentation = useCallback(() => {
		dispatch({ type: 'presented', snapshot: publishSnapshot([...snapshotRef.current.reminders]) });
	}, [publishSnapshot]);

	// Confirmed state committed with persist: 'later' that the offline copy does not hold yet.
	const unsavedRef = useRef<{ folderPath: string; savedAt: number } | null>(null);
	const commitConfirmedSnapshot = useCallback(async (nextReminders: ReminderRecord[], nextProjects = snapshotRef.current.projects,
		{ etag, deltaBase, persist = true, connectivity = connectivityRef.current }:
		{ etag?: string; deltaBase?: string; persist?: boolean | 'later'; connectivity?: number } = {}) => {
		const savedAt = Date.now();
		const snapshot = publishSnapshot(nextReminders, nextProjects);
		cursor.confirmed({ etag, deltaBase }, savedAt);
		dispatch({ type: 'confirmed', snapshot, savedAt, answered: connectivity === connectivityRef.current });
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
	// The outbox has already removed confirmed commands, so a hidden app killed mid-drain
	// would otherwise lose them from this device until the next read. Save them now.
	useEffect(() => {
		const persist = () => { void persistReminderState(); };
		const persistHidden = () => { if (document.visibilityState === 'hidden') persist(); };
		document.addEventListener('visibilitychange', persistHidden);
		window.addEventListener('pagehide', persist);
		return () => {
			document.removeEventListener('visibilitychange', persistHidden);
			window.removeEventListener('pagehide', persist);
		};
	}, [persistReminderState]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		hydratedCacheRef.current = true;
		unsavedRef.current = null;
		const published = publishSnapshot(snapshot.reminders, snapshot.projects);
		issuesRef.current = snapshot.issues ?? [];
		cursor.hydrate(snapshot);
		dispatch({ type: 'cache-hydrated', snapshot: published, issues: issuesRef.current, savedAt: snapshot.savedAt });
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
			const connectivity = connectivityRef.current;
			dispatch({ type: 'read-started', silent: Boolean(options.silent) });
			try {
				const { path, headers, since } = cursor.request(config.folderPath, issuesRef.current.length === 0);
				const response = await fetchReadyReminderList(
					apiFetch,
					path,
					headers,
					(remaining, total) => {
						if (readApplies()) dispatch({ type: 'indexing', progress: { indexedFiles: Math.max(0, total - remaining), totalFiles: total } });
					},
					// Only the first read after startup waits here; others dispatch at once.
					startupRef.current ? await takeStartupRead(requestKey, path, headers) : undefined,
					readApplies,
				);
				if (response.status !== 304 && !response.ok) throw new Error((await responseError(response, 'Could not load reminders.')).message);
				const body: unknown = response.status === 304 ? undefined : await response.json().catch(() => null);
				if (!readApplies()) return;
				const outcome = decideReminderListResponse({ status: response.status, headers: response.headers, body },
					{ folderPath: config.folderPath, confirmed: snapshotRef.current, since, lastCheckedAt: cursor.lastCheckedAt });
				if (outcome.kind === 'not-modified') {
					const savedAt = Date.now();
					cursor.notModified(response.headers, savedAt);
					dispatch({ type: 'confirmed', savedAt, answered: connectivity === connectivityRef.current });
					void refreshCachedReminderSnapshot(
						config.folderPath,
						savedAt,
						cursor.persistedEtag,
					);
					return;
				}
				if (outcome.dropDeltaBase) cursor.dropDeltaBase();
				if (outcome.kind === 'invalid') {
					dispatch({ type: 'list-rejected', message: outcome.message, showErrorState: outcome.showErrorState });
					return;
				}
				issuesRef.current = outcome.result.issues;
				dispatch({ type: 'list-received', issues: outcome.result.issues });
				void commitConfirmedSnapshot(outcome.result.reminders, outcome.result.projects, { etag: outcome.etag, deltaBase: outcome.deltaBase, connectivity });
			} catch (loadError) {
				if (!readApplies()) return;
				const cached = needsDiskFallback(cursor.lastCheckedAt) ? await loadCachedReminderSnapshot(config.folderPath) : undefined;
				if (!readApplies()) return;
				const outcome = decideReminderListFailure(loadError, { lastCheckedAt: cursor.lastCheckedAt, cached });
				if (outcome.kind === 'hydrate-cache') hydrateCachedSnapshot(outcome.cached);
				dispatch({ type: 'read-failed', outcome: outcome.kind, message: outcome.message });
			} finally {
				if (sessionCurrent() && requestCoordinatorRef.current.isLatestRead(readToken)) dispatch({ type: 'read-settled' });
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
		dispatch({ type: 'reads-detached' });
	}, []);

	const beginLocalMutation = useCallback(() => {
		const coordinator = requestCoordinatorRef.current;
		const finish = coordinator.beginMutation();
		activeReadRef.current = null;
		dispatch({ type: 'reads-detached' });
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
		const snapshot = publishSnapshot([], []);
		issuesRef.current = [];
		hydratedCacheRef.current = false;
		activeReadRef.current = null;
		dispatch({ type: 'reset', snapshot });
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
				if (!cancelled && current() && !(cause instanceof EncryptionKeyRequiredError)) dispatch({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) });
			} finally { if (!cancelled) dispatch({ type: 'hydration-finished', authority }); }
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
		hydrated: state.hydratedAuthority === authority,
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
	};
}
