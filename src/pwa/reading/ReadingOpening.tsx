import { PwaOpeningDock } from '../components/PwaOpeningDock';
import React, { useContext } from 'react';
import { FeatureSwitcherButton, FeatureNavigationContext } from '../components/FeatureSwitcherButton';
import { IconButton } from '@/ui/shared/IconButton';
import { ViewHeader } from '@/ui/shared/ViewHeader';
import { ReadingListSkeleton } from '@/reading/ui/ReadingListSkeleton';

export function ReadingOpening() {
	const tab = useContext(FeatureNavigationContext)?.readingTab;
	return <main className="pwa-screen crate-reading-web pwa-mode-opening pwa-reading-opening">
		<ViewHeader
			className="crate-reading__header pwa-reading-opening__header"
			title={tab === 'favorites' ? 'Favorites' : tab === 'archived' ? 'Archive' : 'Reading'}
			count={0}
			countUnit="saved link"
			metaContent={<span className="pwa-mode-opening__meta pwa-mode-opening__shape" aria-hidden="true" />}
			rightContent={<div className="crate-view-header-actions"><span className="pwa-reading-opening__sync" aria-hidden="true" /><span inert aria-hidden="true"><IconButton size="large" iconSize="l" icon="settings" label="Open settings" onClick={() => {}} /></span><FeatureSwitcherButton /></div>}
		/>
		<div className="pwa-reading-opening__search pwa-mode-opening__shape" aria-hidden="true" />
		<div className="pwa-mode-opening__content"><ReadingListSkeleton /></div>
		<PwaOpeningDock tab="reading" />
	</main>;
}
