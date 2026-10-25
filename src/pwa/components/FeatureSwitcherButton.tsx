import { useSharedFeatures } from '../shared-features';
import React, { useContext } from 'react';
import { FeatureNavigationContext } from '../navigation/feature-navigation';
import { IconButton } from '@/ui/shared/IconButton';

/** Each app places the same switcher in its own existing header. */
export function FeatureSwitcherButton() {
	const navigation = useContext(FeatureNavigationContext);
	const features = useSharedFeatures();
	if (!navigation || !features[navigation.section === 'reading' ? 'reminders' : 'reading']) return null;
	const destination = navigation.section === 'reading' ? 'Reminders' : 'Reading';
	return <IconButton className="pwa-feature-switch-button" size="large" iconSize="l" icon={navigation.section === 'reading' ? 'list-todo' : 'book-open'} label={`Switch to ${destination}`} onClick={navigation.toggle} />;
}
