import React from 'react';
import { FeatureSwitcherButton } from '../components/FeatureSwitcherButton';
import { ReadingListSkeleton } from '@/reading/ui/ReadingListSkeleton';

export function ReadingOpening() {
	return <main className="crate-reading-web pwa-mode-opening pwa-reading-opening">
		<header className="pwa-mode-opening__header">
			<div className="pwa-mode-opening__heading"><h1>Reading</h1><span className="pwa-mode-opening__meta pwa-mode-opening__shape" aria-hidden="true" /></div>
			<div className="pwa-mode-opening__actions"><span className="pwa-mode-opening__action pwa-mode-opening__shape" aria-hidden="true" /><FeatureSwitcherButton /></div>
		</header>
		<div className="pwa-reading-opening__search pwa-mode-opening__shape" aria-hidden="true" />
		<div className="pwa-mode-opening__content"><ReadingListSkeleton /></div>
		<span className="pwa-mode-opening__fab pwa-mode-opening__shape" aria-hidden="true" />
		<div className="pwa-mode-opening__nav" aria-hidden="true">{Array.from({ length: 3 }, (_, index) => <span className="pwa-mode-opening__nav-item" key={index}><span className="pwa-mode-opening__nav-icon pwa-mode-opening__shape" /><span className="pwa-mode-opening__nav-label pwa-mode-opening__shape" /></span>)}</div>
	</main>;
}
