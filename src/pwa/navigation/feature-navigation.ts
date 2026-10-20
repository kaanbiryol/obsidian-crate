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
  dockIndex: number | null;
  rememberReminderDockIndex: (index: number) => void;
  readingTab: ReadingSection;
  rememberReadingTab: (tab: ReadingSection) => void;
} | null>(null);
