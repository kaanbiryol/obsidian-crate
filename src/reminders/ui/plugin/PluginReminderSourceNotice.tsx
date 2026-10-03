import React, { useState } from 'react';
import type { ReminderSourceIssue } from '../../data/reminder-source-issues';
import { Button } from '@/ui/shared/Button';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { presentReminderSourceIssues } from './reminder-source-issue-presentation';

interface PluginReminderSourceNoticeProps {
	issues: ReminderSourceIssue[];
	onRefresh: () => Promise<unknown>;
	onOpenNote: (path: string) => Promise<unknown>;
}

export function PluginReminderSourceNotice(props: PluginReminderSourceNoticeProps) {
	// Unmount the recovery controls when the index recovers, including any old
	// action error. A later failure should start with fresh recovery controls.
	return props.issues.length ? <SourceNotice {...props} /> : null;
}

function SourceNotice({ issues, onRefresh, onOpenNote }: PluginReminderSourceNoticeProps) {
	const presentedIssues = presentReminderSourceIssues(issues);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState('');
	const refresh = async () => {
		setRefreshing(true);
		setError('');
		try { await onRefresh(); }
		catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not scan the notes. Try again.'); }
		finally { setRefreshing(false); }
	};
	const openNote = async (path: string) => {
		setError('');
		try { await onOpenNote(path); }
		catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the note. Try again.'); }
	};
	const retry = <Button variant="ghost" className="crate-reminder-source-notice__retry" onClick={() => { void refresh(); }} disabled={refreshing} aria-busy={refreshing}>
		{refreshing ? 'Retrying…' : 'Retry'}
	</Button>;
	return <section className="crate-reminder-source-notice" aria-label="Notes needing attention">
		<ThemeIcon id="triangle-alert" size="xs" aria-hidden className="crate-reminder-source-notice__icon" />
		<div className="crate-reminder-source-notice__content">
			<p className="crate-reminder-source-notice__title" role="status">{issues.length === 1 ? presentedIssues[0]!.title : 'Couldn’t read some reminders'}</p>
			<ul className="crate-reminder-source-notice__files" aria-label="Affected notes">
				{presentedIssues.map(issue => <li key={issue.path}>
					<p className="crate-reminder-source-notice__path" title={issue.path}>{issue.location}</p>
					<p className="crate-reminder-source-notice__reason">{issue.description} <span className="crate-reminder-source-notice__guidance">Editing is paused.</span></p>
					<div className="crate-reminder-source-notice__actions">
						<Button variant="ghost" className="crate-reminder-source-notice__open" onClick={() => { void openNote(issue.path); }} aria-label={`Open note: ${issue.path}`}>
							Open note <ThemeIcon id="arrow-up-right" size="xs" aria-hidden />
						</Button>
						{issues.length === 1 && retry}
					</div>
				</li>)}
			</ul>
			{issues.length > 1 && <div className="crate-reminder-source-notice__footer">
				<p>{issues.length} affected notes</p>
				{retry}
			</div>}
			{error && <p className="crate-reminder-source-notice__error" role="alert">{error}</p>}
		</div>
	</section>;
}
