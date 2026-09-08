import React, { useState } from 'react';
import type { ReminderSourceIssue } from '../types';

export function ReminderSourceNotice({ issues, refreshing, isOffline, onRefresh }: {
	issues: ReminderSourceIssue[];
	refreshing: boolean;
	isOffline: boolean;
	onRefresh: () => void;
}) {
	const [visibleCount, setVisibleCount] = useState(20);
	if (!issues.length) return null;
	return <section className="pwa-reminder-sync-error" aria-label="Incomplete reminder list">
		<div className="pwa-reminder-sync-error__copy">
			<strong>Some reminders are unavailable</strong>
			<span role="status">{issues.length} {issues.length === 1 ? 'source file could' : 'source files could'} not be loaded. Available reminders are shown. Repair the listed files in Obsidian, sync, then refresh.</span>
			<details>
				<summary>Review affected files ({issues.length})</summary>
				<div className="pwa-reminder-source-list">
					{issues.slice(0, visibleCount).map((issue, index) => <p key={`${issue.path}:${index}`}><strong>{issue.path}</strong><br /><span>{issue.reason}</span></p>)}
				</div>
				{visibleCount < issues.length && <div className="pwa-reminder-sync-error__actions"><button type="button" onClick={() => setVisibleCount(value => value + 20)}>Show more files</button></div>}
			</details>
		</div>
		<div className="pwa-reminder-sync-error__actions">
			<button type="button" onClick={onRefresh} disabled={isOffline || refreshing} aria-busy={refreshing}>Refresh reminders</button>
			<button type="button" onClick={() => { window.location.href = '/notifications/open-obsidian'; }}>Open Obsidian</button>
		</div>
	</section>;
}
