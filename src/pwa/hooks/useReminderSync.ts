import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { capturePwaSession } from '../session-generation';
import { applyReminderDelta, fetchReadyReminderList, parseReminderDeltaResponse, parseReminderListResponse, type ReminderIndexingProgress } from '../reminder-api';
import { isReminderList } from '../reminder-storage-validation';
import { loadCachedReminderSnapshot, rebuildCachedReminderSnapshot, refreshCachedReminderSnapshot, saveCachedReminderSnapshot } from '../reminder-cache';
import { createReminderRequestCoordinator } from '../reminder-request-coordinator';
import { requestSharedFeaturesRefresh } from '../shared-features';
import type { ApiFetch, CachedReminderSnapshot, DataMode, LoadReminders, ReminderRecord, ReminderSourceIssue, StoredConfig } from '../types';

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
	commitReminderState: (reminders: ReminderRecord[], projects?: string[]) => Promise<void>;
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
	const etagRef = useRef<string | undefined>(undefined);
	// The ETag stored with the offline copy; 304 freshness is recorded against it.
	const persistedEtagRef = useRef<string | undefined>(undefined);
	// Server changelog position of the confirmed snapshot. Locally confirmed
	// changes since then are in notes the next delta replaces, so it stays valid.
	const deltaBaseRef = useRef<string | undefined>(undefined);
	const lastCheckedAtRef = useRef<number | null>(null);
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

	const commitConfirmedSnapshot = useCallback(async (nextReminders: ReminderRecord[], nextProjects = snapshotRef.current.projects, etag?: string, deltaBase?: string) => {
		const savedAt = Date.now();
		publishSnapshot(nextReminders, nextProjects);
		etagRef.current = etag;
		persistedEtagRef.current = etag;
		if (deltaBase !== undefined) deltaBaseRef.current = deltaBase;
		lastCheckedAtRef.current = savedAt;
		setLastUpdatedAt(savedAt);
		setDataMode('live');
		setIsOffline(false);
		await saveCachedReminderSnapshot(config.folderPath, nextReminders, nextProjects, savedAt, etag, issuesRef.current, deltaBaseRef.current);
	}, [config.folderPath, publishSnapshot]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		hydratedCacheRef.current = true;
		setLoading(false);
		publishSnapshot(snapshot.reminders, snapshot.projects);
		issuesRef.current = snapshot.issues ?? [];
		setIssues(issuesRef.current);
		etagRef.current = snapshot.etag;
		persistedEtagRef.current = snapshot.etag;
		deltaBaseRef.current = snapshot.deltaBase;
		lastCheckedAtRef.current = snapshot.savedAt;
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
	}, [publishSnapshot]);

	const loadReminders = useCallback((options: { silent?: boolean; maxAgeMs?: number } = {}) => {
		if (!authToken || !enabledRef.current) return Promise.resolve();
		if (
			options.maxAgeMs !== undefined
			&& lastCheckedAtRef.current !== null
			&& Date.now() - lastCheckedAtRef.current < options.maxAgeMs
		) {
			return Promise.resolve();
		}

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
				const headers = new Headers();
				if (etagRef.current) headers.set('If-None-Match', etagRef.current);
				// Ask for notes changed since a complete confirmed snapshot only.
				const since = deltaBaseRef.current && issuesRef.current.length === 0 ? deltaBaseRef.current : undefined;
				const response = await fetchReadyReminderList(
					apiFetch,
					`/reminders/list?folderPath=${encodeURIComponent(config.folderPath)}${since ? `&since=${encodeURIComponent(since)}` : ''}`,
					headers,
					(remaining, total) => {
						if (sessionCurrent() && requestCoordinatorRef.current.shouldApplyRead(readToken)) {
							setIndexingProgress({ indexedFiles: Math.max(0, total - remaining), totalFiles: total });
						}
					},
				);
				if (response.status === 304) {
					if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
					// Other vault changes refresh the ETag and delta base of unchanged reminders.
					etagRef.current = response.headers.get('ETag') ?? etagRef.current;
					deltaBaseRef.current = response.headers.get('X-Crate-Delta-Base') ?? deltaBaseRef.current;
					const savedAt = Date.now();
					lastCheckedAtRef.current = savedAt;
					setLastUpdatedAt(savedAt);
					setDataMode('live');
					setIsOffline(false);
					void refreshCachedReminderSnapshot(
						config.folderPath,
						savedAt,
						persistedEtagRef.current,
					);
					return;
				}
				if (!response.ok) throw new Error(await response.text());
				const body: unknown = await response.json().catch(() => null);
				if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
				// A delta lists only changed notes: it must never be read as a full list.
				const isDelta = Boolean(body && typeof body === 'object' && (body as { delta?: unknown }).delta === true);
				const delta = isDelta && since ? parseReminderDeltaResponse(body, config.folderPath) : null;
				const merged = delta ? applyReminderDelta(snapshotRef.current.reminders, delta) : null;
				const result = !isDelta ? parseReminderListResponse(body, config.folderPath)
					: delta && merged && isReminderList(merged, config.folderPath) ? { reminders: merged, projects: delta.projects, issues: [] } : null;
				// An unusable delta drops the base, so the next read is a full one.
				if (isDelta && !result) deltaBaseRef.current = undefined;
				if (!result) {
					// A contract failure cannot replace a valid revision or its ETag,
					// including with an older disk snapshot after a recent acknowledgement.
					setError('The server returned invalid reminder data. Refresh reminders.');
					if (lastCheckedAtRef.current === null) setDataMode('error');
					return;
				}
				setError(null);
				issuesRef.current = result.issues;
				setIssues(result.issues);
				void commitConfirmedSnapshot(result.reminders, result.projects, response.headers.get('ETag') ?? undefined,
					response.headers.get('X-Crate-Delta-Base') ?? undefined);
			} catch (loadError) {
				if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
				const message = loadError instanceof Error ? loadError.message : String(loadError);
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
	}, [apiFetch, authToken, config.folderPath, hydrateCachedSnapshot, commitConfirmedSnapshot]);

	const rebuildOfflineCache = useCallback(async () => {
		const sessionCurrent = capturePwaSession();
		if (!await rebuildCachedReminderSnapshot(config.folderPath) || !sessionCurrent()) return;
		etagRef.current = undefined;
		deltaBaseRef.current = undefined;
		lastCheckedAtRef.current = null;
		activeReadRef.current = null;
		await loadReminders({ silent: true });
	}, [config.folderPath, loadReminders]);

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
		etagRef.current = undefined;
		persistedEtagRef.current = undefined;
		deltaBaseRef.current = undefined;
		lastCheckedAtRef.current = null;
	}, [publishSnapshot]);

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
		commitReminderState: commitConfirmedSnapshot,
		resetReminderState,
		refreshPresentation,
		reportError: setError,
	};
}
