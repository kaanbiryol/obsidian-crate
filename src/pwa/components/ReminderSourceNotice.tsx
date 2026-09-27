import { PwaButton } from './PwaButton';
import { PwaNotice } from './PwaNotice';
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
	return <PwaNotice title="Some reminders are unavailable" aria-label="Incomplete reminder list" actions={<>
		<PwaButton variant="ghost" size="touch" onClick={onRefresh} disabled={isOffline || refreshing} aria-busy={refreshing}>Refresh reminders</PwaButton>
		<PwaButton variant="ghost" size="touch" onClick={() => { window.location.href = '/notifications/open-obsidian'; }}>Open Obsidian</PwaButton>
	</>}>
		<span role="status">{issues.length} {issues.length === 1 ? 'source file could' : 'source files could'} not be loaded. Available reminders are shown. Repair the listed files in Obsidian, sync, then refresh.</span>
		<details>
			<summary>Review affected files ({issues.length})</summary>
			<div className="pwa-reminder-source-list">
				{issues.slice(0, visibleCount).map((issue, index) => <p key={`${issue.path}:${index}`}><strong>{issue.path}</strong><br /><span>{issue.reason}</span></p>)}
			</div>
			{visibleCount < issues.length && <PwaButton variant="ghost" size="touch" onClick={() => setVisibleCount(value => value + 20)}>Show more files</PwaButton>}
		</details>
	</PwaNotice>;
}
