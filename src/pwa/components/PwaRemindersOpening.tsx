import React from 'react';
import type { StartTab } from '../types';

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
			<div className="pwa-mode-opening__heading"><div className="view-header-title-row"><h1 className="view-header-title">{project ?? TITLES[tab]}</h1></div><div className="pwa-reminders-opening__meta"><span className="pwa-mode-opening__meta pwa-mode-opening__shape" aria-hidden="true" /></div></div>
			<div className="pwa-mode-opening__actions"><span className="pwa-mode-opening__action pwa-mode-opening__shape" aria-hidden="true" /></div>
		</header>
		<div className="pwa-mode-opening__content"><PwaRemindersSkeletonRows /></div>
		<div className="pwa-dock pwa-dock--opening" aria-hidden="true"><div className="pwa-dock__bar"><span className="pwa-dock__surface" />{Array.from({ length: 4 }, (_, index) => <span key={index} className="pwa-dock__tab"><span className="pwa-mode-opening__nav-icon pwa-mode-opening__shape" /></span>)}</div><span className="pwa-dock__add"><span className="pwa-mode-opening__nav-icon pwa-mode-opening__shape" /></span></div>
	</main>;
}
