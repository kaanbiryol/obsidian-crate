import React, { createContext, useContext } from 'react';
import { IconButton } from '@/ui/shared/IconButton';

export type CrateSection = 'reading' | 'reminders';
export const FeatureNavigationContext = createContext<{ section: CrateSection; toggle: () => void } | null>(null);

/** Each app places the same switcher in its own existing header. */
export function FeatureSwitcherButton() {
	const navigation = useContext(FeatureNavigationContext);
	if (!navigation) return null;
	const destination = navigation.section === 'reading' ? 'Reminders' : 'Reading';
	return <IconButton className="pwa-feature-switch-button" size="large" iconSize="l" icon={navigation.section === 'reading' ? 'list-todo' : 'book-open'} label={`Switch to ${destination}`} onClick={navigation.toggle} />;
}
