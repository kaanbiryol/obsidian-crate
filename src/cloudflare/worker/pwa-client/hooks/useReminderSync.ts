import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
	loadCachedReminderSnapshot,
	saveCachedReminderSnapshot,
} from '../config';
import type { CachedReminderSnapshot, DataMode, ReminderRecord, StoredConfig } from '../types';

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ReminderSyncState {
	reminders: ReminderRecord[];
	projects: string[];
	loading: boolean;
	refreshing: boolean;
	error: string | null;
	dataMode: DataMode;
	lastUpdatedAt: number | null;
	isOffline: boolean;
	remindersRef: MutableRefObject<ReminderRecord[]>;
	projectsRef: MutableRefObject<string[]>;
	hydratedCacheRef: MutableRefObject<boolean>;
	hydrateCachedSnapshot: (snapshot: CachedReminderSnapshot) => void;
	loadReminders: (options?: { silent?: boolean }) => Promise<void>;
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
	const remindersRef = useRef(reminders);
	const projectsRef = useRef(projects);
	const hydratedCacheRef = useRef(false);

	useEffect(() => {
		remindersRef.current = reminders;
	}, [reminders]);

	useEffect(() => {
		projectsRef.current = projects;
	}, [projects]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		setReminders(snapshot.reminders);
		setProjects(snapshot.projects);
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
		setSelectedProject((current) => current && !snapshot.projects.includes(current) ? null : current);
	}, [setSelectedProject]);

	const loadReminders = useCallback(async (options: { silent?: boolean } = {}) => {
		if (!authToken) return;
		if (options.silent) setRefreshing(true);
		else setLoading(true);
		setError(null);
		try {
			if (!navigator.onLine) {
				const cached = loadCachedReminderSnapshot(config.folderPath);
				if (cached) {
					hydrateCachedSnapshot(cached);
					return;
				}
				throw new Error('Offline');
			}

			const response = await apiFetch(`/reminders/list?folderPath=${encodeURIComponent(config.folderPath)}`);
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { reminders?: ReminderRecord[]; projects?: string[] };
			const nextReminders = Array.isArray(result.reminders) ? result.reminders : [];
			const nextProjects = Array.isArray(result.projects) ? result.projects : [];
			const savedAt = Date.now();
			setReminders(nextReminders);
			setProjects(nextProjects);
			setSelectedProject((current) => current && !nextProjects.includes(current) ? null : current);
			setLastUpdatedAt(savedAt);
			setDataMode('live');
			setIsOffline(false);
			saveCachedReminderSnapshot(config.folderPath, nextReminders, nextProjects, savedAt);
		} catch (loadError) {
			const message = loadError instanceof Error ? loadError.message : String(loadError);
			const cached = loadCachedReminderSnapshot(config.folderPath);
			if (cached) {
				hydrateCachedSnapshot(cached);
				setError(message);
			} else {
				setDataMode('error');
				setError(message);
			}
		} finally {
			setRefreshing(false);
			setLoading(false);
		}
	}, [apiFetch, authToken, config.folderPath, hydrateCachedSnapshot, setSelectedProject]);

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
		setReminders([]);
		setProjects([]);
		setSelectedProject(null);
	}, [setSelectedProject]);

	return {
		reminders,
		projects,
		loading,
		refreshing,
		error,
		dataMode,
		lastUpdatedAt,
		isOffline,
		remindersRef,
		projectsRef,
		hydratedCacheRef,
		hydrateCachedSnapshot,
		loadReminders,
		resetReminderState,
		setReminders,
		setProjects,
		setLoading,
		setError,
	};
}
