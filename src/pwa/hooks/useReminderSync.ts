import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { capturePwaSession } from '../session-generation';
import { fetchReadyReminderList } from '../reminder-api';
import { loadCachedReminderSnapshot, refreshCachedReminderSnapshot, saveCachedReminderSnapshot } from '../reminder-cache';
import { createReminderRequestCoordinator } from '../reminder-request-coordinator';
import { parseReminderSourceIssues } from '../reminder-source-issues';
import type { ApiFetch, CachedReminderSnapshot, DataMode, LoadReminders, ReminderRecord, ReminderSourceIssue, StoredConfig } from '../types';

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
	remindersRef: MutableRefObject<ReminderRecord[]>;
	projectsRef: MutableRefObject<string[]>;
	hydratedCacheRef: MutableRefObject<boolean>;
	hydrateCachedSnapshot: (snapshot: CachedReminderSnapshot) => void;
	loadReminders: LoadReminders;
	beginLocalMutation: () => () => void;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[]) => Promise<void>;
	resetReminderState: () => void;
	setReminders: Dispatch<SetStateAction<ReminderRecord[]>>;
	setProjects: Dispatch<SetStateAction<string[]>>;
	setLoading: Dispatch<SetStateAction<boolean>>;
	setError: Dispatch<SetStateAction<string | null>>;
}

export function useReminderSync({
	apiFetch,
	authToken,
	bootstrapped,
	config,
	setSelectedProject,
}: {
	apiFetch: ApiFetch;
	authToken: string | null;
	bootstrapped: boolean;
	config: StoredConfig;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
}): ReminderSyncState {
	const [reminders, setReminders] = useState<ReminderRecord[]>([]);
	const [projects, setProjects] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dataMode, setDataMode] = useState<DataMode>('live');
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
	const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' ? !navigator.onLine : false);
	const [issues, setIssues] = useState<ReminderSourceIssue[]>([]);
	const issuesRef = useRef<ReminderSourceIssue[]>([]);
	const remindersRef = useRef(reminders);
	const projectsRef = useRef(projects);
	const hydratedCacheRef = useRef(false);
	const requestCoordinatorRef = useRef(createReminderRequestCoordinator());
	const etagRef = useRef<string | undefined>(undefined);
	const lastCheckedAtRef = useRef<number | null>(null);
	const activeReadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);

	useEffect(() => {
		remindersRef.current = reminders;
	}, [reminders]);

	useEffect(() => {
		projectsRef.current = projects;
	}, [projects]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		remindersRef.current = snapshot.reminders;
		projectsRef.current = snapshot.projects;
		issuesRef.current = snapshot.issues ?? [];
		setIssues(issuesRef.current);
		etagRef.current = snapshot.etag;
		lastCheckedAtRef.current = snapshot.savedAt;
		setReminders(snapshot.reminders);
		setProjects(snapshot.projects);
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
		setSelectedProject((current) => current && !snapshot.projects.includes(current) ? null : current);
	}, [setSelectedProject]);

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
			const sessionCurrent = capturePwaSession();
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
				const savedAt = Date.now();
				const etag = response.headers.get('ETag') ?? undefined;
				remindersRef.current = nextReminders;
				projectsRef.current = nextProjects;
				etagRef.current = etag;
				lastCheckedAtRef.current = savedAt;
				setReminders(nextReminders);
				setProjects(nextProjects);
				setSelectedProject((current) => current && !nextProjects.includes(current) ? null : current);
				setLastUpdatedAt(savedAt);
				setDataMode('live');
				setIsOffline(false);
				void saveCachedReminderSnapshot(config.folderPath, nextReminders, nextProjects, savedAt, etag, nextIssues);
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
	}, [apiFetch, authToken, config.folderPath, hydrateCachedSnapshot, setSelectedProject]);

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

	const commitReminderState = useCallback(async (nextReminders: ReminderRecord[], nextProjects = projectsRef.current) => {
		const savedAt = Date.now();
		remindersRef.current = nextReminders;
		projectsRef.current = nextProjects;
		etagRef.current = undefined;
		lastCheckedAtRef.current = savedAt;
		setReminders(nextReminders);
		setProjects(nextProjects);
		setSelectedProject((current) => current && !nextProjects.includes(current) ? null : current);
		setLastUpdatedAt(savedAt);
		setDataMode('live');
		setIsOffline(false);
		await saveCachedReminderSnapshot(config.folderPath, nextReminders, nextProjects, savedAt, undefined, issuesRef.current);
	}, [config.folderPath, setSelectedProject]);

	useEffect(() => {
		const handleOnline = () => {
			setIsOffline(false);
			if (bootstrapped && authToken) void loadReminders({ silent: true });
		};
		const handleOffline = () => setIsOffline(true);

		window.addEventListener('online', handleOnline);
		window.addEventListener('offline', handleOffline);
		return () => {
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('offline', handleOffline);
		};
	}, [authToken, bootstrapped, loadReminders]);

	const resetReminderState = useCallback(() => {
		requestCoordinatorRef.current = createReminderRequestCoordinator();
		remindersRef.current = [];
		projectsRef.current = [];
		issuesRef.current = [];
		setIssues([]);
		hydratedCacheRef.current = false;
		activeReadRef.current = null;
		setLoading(false);
		setRefreshing(false);
		setLastUpdatedAt(null);
		setReminders([]);
		setProjects([]);
		setSelectedProject(null);
		etagRef.current = undefined;
		lastCheckedAtRef.current = null;
	}, [setSelectedProject]);

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
		remindersRef,
		projectsRef,
		hydratedCacheRef,
		hydrateCachedSnapshot,
		loadReminders,
		beginLocalMutation,
		commitReminderState,
		resetReminderState,
		setReminders,
		setProjects,
		setLoading,
		setError,
	};
}
