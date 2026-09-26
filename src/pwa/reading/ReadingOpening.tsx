import React from 'react';
import { FeatureSwitcherButton } from '../components/FeatureSwitcherButton';
import { ViewHeader } from '@/ui/shared/ViewHeader';
import { ReadingListSkeleton } from '@/reading/ui/ReadingListSkeleton';

export function ReadingOpening() {
	return <main className="crate-reading-web pwa-mode-opening pwa-reading-opening">
		<ViewHeader
			className="crate-reading__header pwa-reading-opening__header"
			title="Reading"
			count={0}
			countUnit="saved link"
			titleContent={<span className="pwa-reading-opening__sync" aria-hidden="true" />}
			metaContent={<span className="pwa-mode-opening__meta pwa-mode-opening__shape" aria-hidden="true" />}
			rightContent={<div className="crate-view-header-actions"><span className="pwa-mode-opening__action pwa-mode-opening__shape" aria-hidden="true" /><FeatureSwitcherButton /></div>}
		/>
		<div className="pwa-reading-opening__search pwa-mode-opening__shape" aria-hidden="true" />
		<div className="pwa-mode-opening__content"><ReadingListSkeleton /></div>
		<div className="pwa-dock pwa-dock--opening" aria-hidden="true"><div className="pwa-dock__bar"><span className="pwa-dock__surface" />{Array.from({ length: 4 }, (_, index) => <span key={index} className="pwa-dock__tab"><span className="pwa-mode-opening__nav-icon pwa-mode-opening__shape" /></span>)}</div><span className="pwa-dock__add"><span className="pwa-mode-opening__nav-icon pwa-mode-opening__shape" /></span></div>
	</main>;
}
