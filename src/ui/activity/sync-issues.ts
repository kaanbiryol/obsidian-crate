import type { SyncIssue } from '../../sync/types';
import { formatSyncIssue } from '../../sync/issues';
import { getSyncPathIssue } from '../../protocol/portable-path';
import type { PendingFileAction } from './file-actions';
import { explainSyncIssue } from './sync-issue-message';

export interface SyncIssueRenderOptions {
	serverUrl?: string;
	fileActions?(path: string): PendingFileAction[];
}

/** A bounded, selectable error list shared by the current failure and saved history. */
export function renderSyncIssues(container: HTMLElement, issues: SyncIssue[], options: SyncIssueRenderOptions = {}): void {
	const visible = issues.slice(0, 50);
	const list = container.createEl('ul', { cls: 'crate-sync-issues', attr: { 'aria-label': 'Sync issues' } });
	let extra: HTMLElement | undefined;
	for (const [index, issue] of visible.entries()) {
		if (index === 3) {
			const disclosure = container.createEl('details', { cls: 'crate-sync-issues-more', attr: { 'data-sync-issue-key': 'more' } });
			disclosure.createEl('summary', { text: `Review ${visible.length - 3} more issues` });
			extra = disclosure.createEl('ul', { cls: 'crate-sync-issues' });
		}
		const row = (extra ?? list).createEl('li', { cls: 'crate-sync-issue' });
		if (issue.path) row.createEl('strong', { text: issue.path, cls: 'crate-sync-issue-path' });
		const explanation = explainSyncIssue(issue, options.serverUrl);
		row.createDiv({ text: explanation.summary, cls: 'crate-sync-issue-summary' });
		row.createDiv({ text: explanation.recovery, cls: 'crate-sync-issue-recovery' });
		const details = row.createEl('details', { cls: 'crate-sync-issue-details', attr: { 'data-sync-issue-key': JSON.stringify([issue.path, issue.message]) } });
		details.createEl('summary', { text: 'Technical details' });
		details.createEl('pre', { text: issue.message });
		const actions = row.createDiv({ cls: 'crate-sync-issue-actions' });
		const feedback = row.createDiv({ cls: 'crate-sync-issue-feedback', attr: { role: 'status', 'aria-live': 'polite' } });
		let fileActions: PendingFileAction[] = [];
		if (issue.path && !getSyncPathIssue(issue.path)) {
			try { fileActions = options.fileActions?.(issue.path) ?? []; }
			catch { /* A server filename may not be accessible on this platform. Keep its details readable. */ }
		}
		for (const action of fileActions) {
			const title = action.id === 'open' ? 'Open file' : action.title;
			const button = actions.createEl('button', { text: title, cls: 'crate-activity-action', attr: { type: 'button', 'aria-label': `${title}: ${issue.path}` } });
			button.addEventListener('click', () => {
				button.disabled = true;
				void action.run().catch(() => feedback.setText('Could not open this file. It may have moved; locate it using the path above.'))
					.finally(() => { button.disabled = false; });
			});
		}
		const copy = actions.createEl('button', { text: 'Copy details', cls: 'crate-activity-action', attr: { type: 'button', 'aria-label': `Copy error details${issue.path ? `: ${issue.path}` : ''}` } });
		copy.addEventListener('click', () => {
			const text = [formatSyncIssue(issue), explanation.summary, explanation.recovery].join('\n\n');
			void (async () => {
				try { await navigator.clipboard.writeText(text); feedback.setText('Details copied.'); }
				catch { feedback.setText('Could not copy. Select the path and technical details to copy them manually.'); }
			})();
		});
	}
	if (issues.length > visible.length) container.createDiv({ text: `Showing ${visible.length} of ${issues.length} issues. Resolve these, then sync again to review the remaining errors.`, cls: 'crate-sync-issue-recovery' });
}
