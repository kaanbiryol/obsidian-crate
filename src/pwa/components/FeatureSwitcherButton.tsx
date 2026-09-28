import { useSharedFeatures } from '../shared-features';
import React, { createContext, useContext } from 'react';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import type { TabId } from '@/reminders/ui/layoutConstants';
import { IconButton } from '@/ui/shared/IconButton';

export type CrateSection = 'reading' | 'reminders';
export type DockDestination = { section: 'reading'; tab: ReadingSection } | { section: 'reminders'; tab: TabId };
export const FeatureNavigationContext = createContext<{
  section: CrateSection;
  active: boolean;
  toggle: () => void;
  destination: DockDestination | null;
  navigate: (destination: DockDestination) => void;
  dockIndex: number | null;
  rememberReminderDockIndex: (index: number) => void;
  readingTab: ReadingSection;
  rememberReadingTab: (tab: ReadingSection) => void;
} | null>(null);

/** Each app places the same switcher in its own existing header. */
export function FeatureSwitcherButton() {
	const navigation = useContext(FeatureNavigationContext);
	const features = useSharedFeatures();
	if (!navigation || !features[navigation.section === 'reading' ? 'reminders' : 'reading']) return null;
	const destination = navigation.section === 'reading' ? 'Reminders' : 'Reading';
	return <IconButton className="pwa-feature-switch-button" size="large" iconSize="l" icon={navigation.section === 'reading' ? 'list-todo' : 'book-open'} label={`Switch to ${destination}`} onClick={navigation.toggle} />;
}
