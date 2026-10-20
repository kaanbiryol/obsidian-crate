import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { capturePwaSession } from '../session-generation';
import { fetchReadyReminderList, readReminderListBody, type ReminderIndexingProgress } from './reminder-api';
import { loadCachedReminderSnapshot, rebuildCachedReminderSnapshot, refreshCachedReminderSnapshot, saveCachedReminderSnapshot } from './cache/reminder-cache';
import { createReminderRequestCoordinator } from './outbox/reminder-request-coordinator';
import { createReminderListCursor } from './reminder-list-cursor';
import { requestSharedFeaturesRefresh } from '../shared-features';
import type { ApiFetch, DataMode, StoredConfig } from '../types';
import type { CachedReminderSnapshot, LoadReminders, ReminderRecord, ReminderSourceIssue } from './types';

export interface ConfirmedReminderSnapshot {
	reminders: ReminderRecord[];
	projects: string[];
}

export interface ReminderSyncState {
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
	getSnapshot: () => ConfirmedReminderSnapshot;
	hasHydratedCache: () => boolean;
	hydrateCachedSnapshot: (snapshot: CachedReminderSnapshot) => void;
	loadReminders: LoadReminders;
	rebuildOfflineCache: () => Promise<void>;
	beginLocalMutation: () => () => void;
	/** Drops in-flight reads without starting a write, e.g. after another tab's command settles. */
	invalidateReads: () => void;
	/** Peers applying another tab's persisted confirmation pass persist: false. */
	commitReminderState: (reminders: ReminderRecord[], projects?: string[], options?: { persist?: boolean }) => Promise<void>;
	resetReminderState: () => void;
	refreshPresentation: () => void;
	reportError: (message: string | null) => void;
}

export function useReminderSync({
	apiFetch,
	authToken,
	config,
	setSelectedProject,
	enabled = true,
}: {
	enabled?: boolean;
	apiFetch: ApiFetch;
	authToken: string | null;
	config: StoredConfig;
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
	const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' ? !navigator.onLine : false);
	const [issues, setIssues] = useState<ReminderSourceIssue[]>([]);
	const issuesRef = useRef<ReminderSourceIssue[]>([]);
	const snapshotRef = useRef(snapshot);
	const hydratedCacheRef = useRef(false);
	const requestCoordinatorRef = useRef(createReminderRequestCoordinator());
	const [cursor] = useState(createReminderListCursor);
	const activeReadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);

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

	const commitConfirmedSnapshot = useCallback(async (nextReminders: ReminderRecord[], nextProjects = snapshotRef.current.projects,
		{ etag, deltaBase, persist = true }: { etag?: string; deltaBase?: string; persist?: boolean } = {}) => {
		const savedAt = Date.now();
		publishSnapshot(nextReminders, nextProjects);
		cursor.confirmed({ etag, deltaBase }, savedAt);
		setLastUpdatedAt(savedAt);
		setDataMode('live');
		setIsOffline(false);
		if (persist) await saveCachedReminderSnapshot({ folderPath: config.folderPath, reminders: nextReminders, projects: nextProjects,
			savedAt, etag, issues: issuesRef.current, deltaBase: cursor.deltaBase });
	}, [config.folderPath, cursor, publishSnapshot]);
	const commitReminderState = useCallback((nextReminders: ReminderRecord[], nextProjects?: string[], options?: { persist?: boolean }) =>
		commitConfirmedSnapshot(nextReminders, nextProjects, { persist: options?.persist }), [commitConfirmedSnapshot]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		hydratedCacheRef.current = true;
		setLoading(false);
		publishSnapshot(snapshot.reminders, snapshot.projects);
		issuesRef.current = snapshot.issues ?? [];
		setIssues(issuesRef.current);
		cursor.hydrate(snapshot);
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
	}, [cursor, publishSnapshot]);

	const loadReminders = useCallback((options: { silent?: boolean; maxAgeMs?: number } = {}) => {
		if (!authToken || !enabledRef.current) return Promise.resolve();
		if (cursor.isFresh(options.maxAgeMs)) return Promise.resolve();

		const requestKey = `${config.folderPath}\0${authToken}`;
		if (activeReadRef.current?.key === requestKey) return activeReadRef.current.promise;
		requestSharedFeaturesRefresh();

		const promise = (async () => {
			const session = capturePwaSession();
			const lifetime = lifetimeRef.current;
			const sessionCurrent = () => lifetime.active && session();
			if (!sessionCurrent()) return;
			const readToken = requestCoordinatorRef.current.beginRead();
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
						if (sessionCurrent() && requestCoordinatorRef.current.shouldApplyRead(readToken)) {
							setIndexingProgress({ indexedFiles: Math.max(0, total - remaining), totalFiles: total });
						}
					},
				);
				if (response.status === 304) {
					if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
					const savedAt = Date.now();
					cursor.notModified(response.headers, savedAt);
					setLastUpdatedAt(savedAt);
					setDataMode('live');
					setIsOffline(false);
					void refreshCachedReminderSnapshot(
						config.folderPath,
						savedAt,
						cursor.persistedEtag,
					);
					return;
				}
				if (!response.ok) throw new Error(await response.text());
				const body: unknown = await response.json().catch(() => null);
				if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
				const { result, dropDeltaBase } = readReminderListBody(body, config.folderPath, snapshotRef.current.reminders, since);
				if (dropDeltaBase) cursor.dropDeltaBase();
				if (!result) {
					// A contract failure cannot replace a valid revision or its ETag,
					// including with an older disk snapshot after a recent acknowledgement.
					setError('The server returned invalid reminder data. Refresh reminders.');
					if (cursor.lastCheckedAt === null) setDataMode('error');
					return;
				}
				setError(null);
				issuesRef.current = result.issues;
				setIssues(result.issues);
				void commitConfirmedSnapshot(result.reminders, result.projects, {
					etag: response.headers.get('ETag') ?? undefined, deltaBase: response.headers.get('X-Crate-Delta-Base') ?? undefined,
				});
			} catch (loadError) {
				if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
				const message = loadError instanceof Error ? loadError.message : String(loadError);
				// A loaded snapshot is at least as new as the disk copy; keep it and mark it stale.
				if (cursor.lastCheckedAt !== null) {
					setDataMode('cached');
					setError(message);
					return;
				}
				const cached = await loadCachedReminderSnapshot(config.folderPath);
				if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
				if (cached) {
					hydrateCachedSnapshot(cached);
					setError(message);
				} else {
					setDataMode('error');
					setError(message);
				}
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
	}, [apiFetch, authToken, config.folderPath, cursor, hydrateCachedSnapshot, commitConfirmedSnapshot]);

	const rebuildOfflineCache = useCallback(async () => {
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


	useEffect(() => {
		const handleOnline = () => setIsOffline(false);
		const handleOffline = () => setIsOffline(true);

		window.addEventListener('online', handleOnline);
		window.addEventListener('offline', handleOffline);
		return () => {
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('offline', handleOffline);
		};
	}, []);

	const resetReminderState = useCallback(() => {
		requestCoordinatorRef.current = createReminderRequestCoordinator();
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
		getSnapshot,
		hasHydratedCache,
		hydrateCachedSnapshot,
		rebuildOfflineCache,
		loadReminders,
		beginLocalMutation,
		invalidateReads,
		commitReminderState,
		resetReminderState,
		refreshPresentation,
		reportError: setError,
	};
}
