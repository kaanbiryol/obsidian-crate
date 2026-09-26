import React from 'react';

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
