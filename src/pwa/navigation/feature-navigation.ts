import { createContext } from 'react';
import type { ReadingSection } from '@/reading/core/reading-presentation';
import type { TabId } from '@/reminders/ui/shared/layoutConstants';

export type CrateSection = 'reading' | 'reminders';
export type DockDestination = { section: 'reading'; tab: ReadingSection } | { section: 'reminders'; tab: TabId };
export const FeatureNavigationContext = createContext<{
	section: CrateSection;
	active: boolean;
	toggle: () => void;
	destination: DockDestination | null;
	navigate: (destination: DockDestination) => void;
	/** The dock indicator shared by both features; read with `useSyncExternalStore`. */
	dockIndex: () => number | null;
	subscribeDockIndex: (onChange: () => void) => () => void;
	rememberReminderDockIndex: (index: number) => void;
	/** The last Reading tab, current whenever it is read. */
	readingTab: ReadingSection;
	rememberReadingTab: (tab: ReadingSection) => void;
} | null>(null);

interface RememberedTabs { readingTab: ReadingSection; reminderDockIndex: number | null }

/** Tabs each feature last showed. Changing them notifies the docks without re-rendering the shell. */
export function createRememberedTabs(readingTab: ReadingSection) {
	let current: RememberedTabs = { readingTab, reminderDockIndex: null };
	const listeners = new Set<() => void>();
	const update = (next: Partial<RememberedTabs>) => {
		if (Object.entries(next).every(([key, value]) => current[key as keyof RememberedTabs] === value)) return;
		current = { ...current, ...next };
		for (const listener of listeners) listener();
	};
	return {
		get: () => current,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		rememberReadingTab: (tab: ReadingSection) => update({ readingTab: tab }),
		rememberReminderDockIndex: (index: number) => update({ reminderDockIndex: index }),
	};
}
