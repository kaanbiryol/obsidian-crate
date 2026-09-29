import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { capturePwaSession } from '../session-generation';
import { fetchReadyReminderList } from '../reminder-api';
import { loadCachedReminderSnapshot, rebuildCachedReminderSnapshot, refreshCachedReminderSnapshot, saveCachedReminderSnapshot } from '../reminder-cache';
import { createReminderRequestCoordinator } from '../reminder-request-coordinator';
import { parseReminderSourceIssues } from '../reminder-source-issues';
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
}: {
	apiFetch: ApiFetch;
	authToken: string | null;
	config: StoredConfig;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
}): ReminderSyncState {
	const [snapshot, setSnapshot] = useState<ConfirmedReminderSnapshot>({ reminders: [], projects: [] });
	const { reminders, projects } = snapshot;
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
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
	const lastCheckedAtRef = useRef<number | null>(null);
	const activeReadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);

	const lifetimeRef = useRef({ active: true });
	useEffect(() => {
		const lifetime = { active: true };
		lifetimeRef.current = lifetime;
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

	const commitConfirmedSnapshot = useCallback(async (nextReminders: ReminderRecord[], nextProjects = snapshotRef.current.projects, etag?: string) => {
		const savedAt = Date.now();
		publishSnapshot(nextReminders, nextProjects);
		etagRef.current = etag;
		lastCheckedAtRef.current = savedAt;
		setLastUpdatedAt(savedAt);
		setDataMode('live');
		setIsOffline(false);
		await saveCachedReminderSnapshot(config.folderPath, nextReminders, nextProjects, savedAt, etag, issuesRef.current);
	}, [config.folderPath, publishSnapshot]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		hydratedCacheRef.current = true;
		setLoading(false);
		publishSnapshot(snapshot.reminders, snapshot.projects);
		issuesRef.current = snapshot.issues ?? [];
		setIssues(issuesRef.current);
		etagRef.current = snapshot.etag;
		lastCheckedAtRef.current = snapshot.savedAt;
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
	}, [publishSnapshot]);

	const loadReminders = useCallback((options: { silent?: boolean; maxAgeMs?: number } = {}) => {
		if (!authToken) return Promise.resolve();
		if (
			options.maxAgeMs !== undefined
			&& lastCheckedAtRef.current !== null
			&& Date.now() - lastCheckedAtRef.current < options.maxAgeMs
		) {
			return Promise.resolve();
		}

		const requestKey = `${config.folderPath}\0${authToken}`;
		if (activeReadRef.current?.key === requestKey) return activeReadRef.current.promise;

		const promise = (async () => {
			const session = capturePwaSession();
			const lifetime = lifetimeRef.current;
			const sessionCurrent = () => lifetime.active && session();
			if (!sessionCurrent()) return;
			const readToken = requestCoordinatorRef.current.beginRead();
			if (options.silent) setRefreshing(true);
			else setLoading(true);
			setError(null);
			try {
				const headers = new Headers();
				if (etagRef.current) headers.set('If-None-Match', etagRef.current);
				const response = await fetchReadyReminderList(
					apiFetch,
					`/reminders/list?folderPath=${encodeURIComponent(config.folderPath)}`,
					headers,
					(remaining, total) => { if (sessionCurrent() && requestCoordinatorRef.current.shouldApplyRead(readToken)) setError(`Preparing reminders: ${Math.max(0, total - remaining)} of ${total} files indexed…`); },
				);
				if (response.status === 304) {
					if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
					const savedAt = Date.now();
					lastCheckedAtRef.current = savedAt;
					setLastUpdatedAt(savedAt);
					setDataMode('live');
					setIsOffline(false);
					void refreshCachedReminderSnapshot(
						config.folderPath,
						savedAt,
						etagRef.current,
					);
					return;
				}
				if (!response.ok) throw new Error(await response.text());
				const result = await response.json() as { reminders?: ReminderRecord[]; projects?: string[]; issues?: unknown };
				const nextIssues = parseReminderSourceIssues(result.issues);
				if (!nextIssues) throw new Error('The server returned invalid reminder source details. Refresh reminders.');
				const nextReminders = Array.isArray(result.reminders) ? result.reminders : [];
				const nextProjects = Array.isArray(result.projects) ? result.projects : [];
				if (!sessionCurrent() || !requestCoordinatorRef.current.shouldApplyRead(readToken)) return;
				setError(null);
				issuesRef.current = nextIssues;
				setIssues(nextIssues);
				void commitConfirmedSnapshot(nextReminders, nextProjects, response.headers.get('ETag') ?? undefined);
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
		lastCheckedAtRef.current = null;
		activeReadRef.current = null;
		await loadReminders({ silent: true });
	}, [config.folderPath, loadReminders]);

	const beginLocalMutation = useCallback(() => {
		const coordinator = requestCoordinatorRef.current;
		const finish = coordinator.beginMutation();
		activeReadRef.current = null;
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
		setLastUpdatedAt(null);
		etagRef.current = undefined;
		lastCheckedAtRef.current = null;
	}, [publishSnapshot]);

	return {
		reminders,
		projects,
		loading,
		refreshing,
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
