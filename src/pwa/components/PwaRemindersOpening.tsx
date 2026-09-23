import React from 'react';
import type { StartTab } from '../types';
import { FeatureSwitcherButton } from './FeatureSwitcherButton';

const TITLES: Record<StartTab, string> = { inbox: 'Inbox', today: 'Today', upcoming: 'Upcoming', browse: 'Projects' };

export function PwaRemindersSkeletonRows() {
	return <div className="pwa-reminders-skeleton" role="status" aria-label="Loading reminders">
		<div aria-hidden="true">
			{Array.from({ length: 3 }, (_, index) => <div className="pwa-reminders-skeleton__card" key={index}>
				<span className="pwa-reminders-skeleton__check pwa-mode-opening__shape" />
				<span className="pwa-reminders-skeleton__copy">
					<span className="pwa-reminders-skeleton__title pwa-mode-opening__shape" />
					<span className="pwa-reminders-skeleton__detail pwa-mode-opening__shape" />
				</span>
			</div>)}
		</div>
	</div>;
}

export function PwaRemindersOpening({ tab, project }: { tab: StartTab; project: string | null }) {
	return <main className="pwa-mode-opening pwa-reminders-opening">
		<header className="pwa-mode-opening__header">
			<div className="pwa-mode-opening__heading"><h1>{project ?? TITLES[tab]}</h1><span className="pwa-mode-opening__meta pwa-mode-opening__shape" aria-hidden="true" /></div>
			<div className="pwa-mode-opening__actions"><span className="pwa-mode-opening__action pwa-mode-opening__shape" aria-hidden="true" /><FeatureSwitcherButton /></div>
		</header>
		<div className="pwa-mode-opening__content"><PwaRemindersSkeletonRows /></div>
		<span className="pwa-mode-opening__fab pwa-mode-opening__shape" aria-hidden="true" />
		<div className="pwa-mode-opening__nav" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <span className="pwa-mode-opening__nav-item" key={index}><span className="pwa-mode-opening__nav-icon pwa-mode-opening__shape" /><span className="pwa-mode-opening__nav-label pwa-mode-opening__shape" /></span>)}</div>
	</main>;
}
