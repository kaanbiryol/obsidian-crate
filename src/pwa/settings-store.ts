import type { ReactNode, SetStateAction } from 'react';
import type { SyncIndicatorState } from '@/ui/shared/SyncIndicator';
import type { PushState, StoredConfig } from './types';

interface FeatureSettings {
	ready: boolean;
	connected: boolean;
	status: { state: SyncIndicatorState; label: string };
	attention: string | null;
	unsynced: boolean;
	/** Feature hydration and transient work must settle before navigating for an update. */
	updateReady?: boolean;
	updateContentReady?: boolean;
	onRefresh: () => Promise<unknown>;
	onLogout: () => Promise<void>;
}

export interface RemindersSettings extends FeatureSettings {
	onExport?: () => void | Promise<void>;
	config: StoredConfig;
	push: PushState;
	onEnablePush: () => Promise<void>;
	recovery: ReactNode;
}

interface ReadingSettings extends FeatureSettings {
	unavailable?: string;
	shortcut: ReactNode;
	issues: ReactNode;
}

export interface SettingsSnapshot {
	open: boolean;
	reminders: RemindersSettings | null;
	reading: ReadingSettings | null;
}

/** Feature runtimes publish to the sheet without rerendering each other. */
export function createSettingsStore(initiallyOpen = false) {
	let snapshot: SettingsSnapshot = { open: initiallyOpen, reminders: null, reading: null };
	const listeners = new Set<() => void>();
	const publish = (next: SettingsSnapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
	return {
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot: () => snapshot,
		getOpen: () => snapshot.open,
		setOpen: (next: SetStateAction<boolean>) => {
			const open = typeof next === 'function' ? next(snapshot.open) : next;
			if (open !== snapshot.open) publish({ ...snapshot, open });
		},
		setFeature: <K extends 'reading' | 'reminders'>(feature: K, value: SettingsSnapshot[K]) => publish({ ...snapshot, [feature]: value }),
	};
}
