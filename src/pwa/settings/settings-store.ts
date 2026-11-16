import { isValidElement, type ReactNode, type SetStateAction } from 'react';
import type { SyncIndicatorState } from '@/ui/shared/SyncIndicator';
import type { StoredConfig } from '../types';
import type { PushState } from '../reminders/types';
import type { PendingReminderChange } from '../reminders/outbox/reminder-outbox-types';
import type { QuarantinedReminderEntry } from '../reminders/outbox/reminder-outbox-storage';

interface FeatureSettings {
	enabled?: boolean;
	pendingCount?: number;
	retryAt?: number;
	onExport?: () => void | Promise<void>;
	ready: boolean;
	connected: boolean;
	status: { state: SyncIndicatorState; label: string };
	attention: string | null;
	unsynced: boolean;
	/** Feature hydration and transient work must settle before navigating for an update. */
	updateReady: boolean;
	/** Check transient work again even before React publishes its next render. */
	canApplyUpdate: () => boolean;
	/** Durable work blocks updates until the user acts, so launch need not wait for it. */
	updateBlocked?: boolean;
	updateContentReady: boolean;
	onRefresh: () => Promise<unknown>;
	onLogout: () => Promise<void>;
	clearView?: () => void;
}

export interface RemindersSettings extends FeatureSettings {
	config: StoredConfig;
	push: PushState;
	onEnablePush: () => Promise<void>;
	/** Saved changes from earlier sessions and damaged entries, which the sheet lists for review. */
	recoveryChanges: PendingReminderChange[];
	quarantinedChanges: QuarantinedReminderEntry[];
	onResumeRecovery?: () => void;
	onRemoveQuarantined: (entries: QuarantinedReminderEntry[]) => Promise<boolean>;
}

interface ReadingSettings extends FeatureSettings {
	unavailable?: string;
	encryption?: { status: 'ready' | 'unencrypted' | 'locked'; folderPath: string };
	/** Memoized by the feature, so an unchanged model keeps the same elements. */
	shortcut: ReactNode;
	issues: ReactNode;
}

export interface SettingsSnapshot {
	open: boolean;
	syncRequested: boolean;
	reminders: RemindersSettings | null;
	reading: ReadingSettings | null;
}

/** Whether two values have the same own fields, compared with `same` (identity by default). */
export function shallowEqual<T>(a: T, b: T, same: (x: unknown, y: unknown) => boolean = Object.is): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length
		&& keys.every(key => Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

const isPlainValue = (value: unknown): value is object => typeof value === 'object' && value !== null && !isValidElement(value)
	&& (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);

/** Runtimes rebuild their model on every render: a status object or an empty list
 * compares by its fields, so an unchanged model wakes no subscriber. */
function sameFeature(a: unknown, b: unknown): boolean {
	return shallowEqual(a, b, (x, y) => Object.is(x, y)
		|| (isPlainValue(x) && isPlainValue(y) && Array.isArray(x) === Array.isArray(y) && shallowEqual(x, y)));
}

/** Feature runtimes publish to the sheet without rerendering each other. */
export function createSettingsStore(initiallyOpen = false) {
	let snapshot: SettingsSnapshot = { open: initiallyOpen, syncRequested: false, reminders: null, reading: null };
	const listeners = new Set<() => void>();
	const publish = (next: SettingsSnapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
	return {
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot: () => snapshot,
		getOpen: () => snapshot.open,
		openSync: () => publish({ ...snapshot, open: true, syncRequested: true }),
		setOpen: (next: SetStateAction<boolean>) => {
			const open = typeof next === 'function' ? next(snapshot.open) : next;
			if (open !== snapshot.open) publish({ ...snapshot, open, syncRequested: false });
		},
		setFeature: <K extends 'reading' | 'reminders'>(feature: K, value: SettingsSnapshot[K]) => {
			if (!sameFeature(snapshot[feature], value)) publish({ ...snapshot, [feature]: value });
		},
	};
}
