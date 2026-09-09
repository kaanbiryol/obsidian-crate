import React, { useState } from 'react';
import type { ReminderSourceIssue } from '../../data/reminder-source-issues';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';

export function PluginReminderSourceNotice({ issues, onRefresh }: {
	issues: ReminderSourceIssue[];
	onRefresh: () => Promise<unknown>;
}) {
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState('');
	const [visibleCount, setVisibleCount] = useState(20);
	const refresh = async () => {
		setRefreshing(true);
		setError('');
		try { await onRefresh(); }
		catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh reminders. Try again.'); }
		finally { setRefreshing(false); }
	};
	if (!issues.length && !error) return null;
	return <section className="crate-reminder-source-notice" aria-label="Incomplete reminder list">
		<strong>Some reminders could not be refreshed</strong>
		<p role="status">Saved entries from these notes may be out of date. Editing them is paused until their source can be read. Other notes remain available.</p>
		<details>
			<summary>Review affected files ({issues.length})</summary>
			<div className="crate-reminder-source-notice__files">
				{issues.slice(0, visibleCount).map(issue => <p key={issue.path}><strong>{issue.path}</strong><br />{issue.reason}</p>)}
			</div>
			{visibleCount < issues.length && <ShadowDOMNativeButton onClick={() => setVisibleCount(value => value + 20)}>Show more files</ShadowDOMNativeButton>}
		</details>
		{error && <p role="alert">{error}</p>}
		<ShadowDOMNativeButton onClick={() => { void refresh(); }} disabled={refreshing} aria-busy={refreshing}>
			{refreshing ? 'Refreshing reminders…' : 'Refresh reminders'}
		</ShadowDOMNativeButton>
	</section>;
}
