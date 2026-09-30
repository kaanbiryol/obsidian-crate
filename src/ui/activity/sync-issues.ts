import type { SyncIssue } from '../../sync/types';
import { formatSyncIssue } from '../../sync/issues';
import { getSyncPathIssue } from '../../protocol/portable-path';
import type { PendingFileAction } from './file-actions';
import { explainSyncIssue } from './sync-issue-message';

export interface SyncIssueRenderOptions {
	serverUrl?: string;
	fileActions?(path: string): PendingFileAction[];
}

let nextDetailsId = 0;

export function setSyncIssueDetailsExpanded(panel: HTMLElement, expanded: boolean): void {
	panel.hidden = !expanded;
	panel.closest('.crate-sync-issue')?.querySelector('.crate-sync-issue-toggle')?.setAttribute('aria-expanded', String(expanded));
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
		const sentenceEnd = explanation.recovery.indexOf('. ');
		const nextStep = sentenceEnd < 0 ? explanation.recovery : explanation.recovery.slice(0, sentenceEnd + 1);
		row.createDiv({ text: nextStep, cls: 'crate-sync-issue-recovery' });
		const actions = row.createDiv({ cls: 'crate-sync-issue-actions' });
		const detailsId = `crate-sync-issue-details-${++nextDetailsId}`;
		const details = row.createDiv({ cls: 'crate-sync-issue-details', attr: { id: detailsId, 'data-sync-issue-key': JSON.stringify([issue.path, issue.message]) } });
		details.hidden = true;
		details.createDiv({ text: 'How to fix', cls: 'crate-sync-issue-detail-label' });
		details.createDiv({ text: explanation.recovery, cls: 'crate-sync-issue-repair' });
		details.createDiv({ text: 'Technical details', cls: 'crate-sync-issue-detail-label' });
		details.createEl('pre', { text: issue.message });
		const feedback = row.createDiv({ cls: 'crate-sync-issue-feedback is-status-only', attr: { role: 'status', 'aria-live': 'polite' } });
		const showActionError = (message: string) => { feedback.removeClass('is-status-only'); feedback.setText(message); };
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
				void action.run().catch(() => showActionError('Could not open this file. It may have moved; locate it using the path above.'))
					.finally(() => { button.disabled = false; });
			});
		}
		const toggle = actions.createEl('button', { text: 'Details', cls: 'crate-activity-action crate-sync-issue-toggle', attr: {
			type: 'button', 'aria-expanded': 'false', 'aria-controls': detailsId, 'aria-label': `Details: ${issue.path ?? explanation.summary}`,
		} });
		toggle.addEventListener('click', () => {
			details.hidden = !details.hidden;
			toggle.setAttribute('aria-expanded', String(!details.hidden));
		});
		const copy = actions.createEl('button', { text: 'Copy details', cls: 'crate-activity-action crate-sync-issue-copy', attr: { type: 'button', 'aria-label': `Copy error details${issue.path ? `: ${issue.path}` : ''}` } });
		copy.addEventListener('click', () => {
			const text = [formatSyncIssue(issue), explanation.summary, explanation.recovery].join('\n\n');
			void (async () => {
				copy.disabled = true;
				try {
					await navigator.clipboard.writeText(text);
					copy.setText('Copied');
					feedback.addClass('is-status-only');
					feedback.setText('Details copied.');
				} catch {
					details.hidden = false;
					toggle.setAttribute('aria-expanded', 'true');
					showActionError('Could not copy. Select the path and technical details to copy them manually.');
				}
				finally { copy.disabled = false; }
			})();
		});
	}
	if (issues.length > visible.length) container.createDiv({ text: `Showing ${visible.length} of ${issues.length} issues. Resolve these, then sync again to review the remaining errors.`, cls: 'crate-sync-issue-recovery' });
}
