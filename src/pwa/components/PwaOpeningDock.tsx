import React, { useContext } from 'react';
import { FeatureNavigationContext } from './FeatureSwitcherButton';
import { createPwaOpeningDockHtml } from '../opening-dock';
import type { StartTab } from '../types';
import { useDockMorph } from '@/ui/shared/navigation/useDockMorph';

export function PwaOpeningDock({ tab }: { tab: StartTab | 'reading' }) {
	const readingTab = useContext(FeatureNavigationContext)?.readingTab;
	const surface = useDockMorph(false, 158, true);
	return <div className="pwa-opening-dock-mount" ref={element => surface(element?.querySelector('.pwa-dock__surface') ?? null)} dangerouslySetInnerHTML={{ __html: createPwaOpeningDockHtml(tab, readingTab) }} />;
}
