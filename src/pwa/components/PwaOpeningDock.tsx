import React, { useContext } from 'react';
import { FeatureNavigationContext } from './FeatureSwitcherButton';
import { createPwaOpeningDockHtml } from '../opening-dock';
import type { StartTab } from '../types';

export function PwaOpeningDock({ tab }: { tab: StartTab | 'reading' }) {
	const readingTab = useContext(FeatureNavigationContext)?.readingTab;
	return <div className="pwa-opening-dock-mount" dangerouslySetInnerHTML={{ __html: createPwaOpeningDockHtml(tab, readingTab) }} />;
}
