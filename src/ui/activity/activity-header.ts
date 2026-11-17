import { setIcon } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBarIndicator } from '../sync-status/StatusBarIndicator';
import type { SyncState } from '../../sync/types';
import type { describeActivityStatus } from './activity-status';
import type { PendingFileAction } from './file-actions';
import { renderSyncIssues } from './sync-issues';

type ActivityStatus = ReturnType<typeof describeActivityStatus>;

export interface ActivityHeaderOptions {
	getStatus(): ActivityStatus;
	getState(): SyncState;
	getServerUrl(): string;
	fileActions(path: string): PendingFileAction[];
}

/** Sync status in the Activity header, plus the sync error notice above the tabs. The
 * sync and stop control sits under the Pending file list, next to the files it syncs. */
export class ActivityHeader {
	private readonly subtitleEl: HTMLSpanElement;
	private readonly subtitleLabelEl: HTMLSpanElement;
	private subtitleIndicatorRoot: Root | undefined;
	private readonly errorNoticeEl: HTMLDivElement;
	private readonly errorTitleEl: HTMLSpanElement;
	private readonly errorIssuesEl: HTMLDivElement;
	private errorSignature = '';

	constructor(header: HTMLElement, contentEl: HTMLElement, private readonly options: ActivityHeaderOptions) {
		this.subtitleEl = header.createSpan({ cls: 'crate-activity-subtitle', attr: { role: 'status' } });
		this.subtitleIndicatorRoot = createRoot(this.subtitleEl.createSpan({ cls: 'crate-activity-subtitle-indicator' }));
		this.subtitleLabelEl = this.subtitleEl.createSpan({ cls: 'crate-activity-subtitle-label' });

		this.errorNoticeEl = contentEl.createDiv({
			cls: 'crate-sync-error-notice',
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		const errorIconEl = this.errorNoticeEl.createDiv({ cls: 'crate-sync-error-icon' });
		setIcon(errorIconEl, 'alert-triangle');
		const errorCopyEl = this.errorNoticeEl.createDiv({ cls: 'crate-sync-error-copy' });
		this.errorTitleEl = errorCopyEl.createSpan({ text: 'Sync error', cls: 'crate-sync-error-title' });
		this.errorIssuesEl = errorCopyEl.createDiv({ cls: 'crate-sync-error-message' });
		this.updateSyncErrorNotice();
	}

	updateSyncStatusText(status = this.options.getStatus()): void {
		if (this.subtitleLabelEl.textContent !== status.text) this.subtitleLabelEl.setText(status.text);
		this.subtitleIndicatorRoot?.render(createElement(StatusBarIndicator, { state: status.indicatorState }));
		this.subtitleEl.setAttribute('title', status.text);
		this.subtitleEl.setAttribute('data-state', status.subtitleState);
	}

	updateSyncErrorNotice(): void {
		const state = this.options.getState();
		if (state.status !== 'error' && state.status !== 'offline') {
			this.errorNoticeEl.hide();
			return;
		}

		const issues = state.lastIssues?.length ? state.lastIssues : [{ message: state.lastError || 'Cannot reach the sync server.' }];
		const serverUrl = this.options.getServerUrl();
		const signature = JSON.stringify([state.status, issues, serverUrl]);
		if (signature !== this.errorSignature) {
			this.errorSignature = signature;
			this.errorTitleEl.setText(state.status === 'offline' ? 'Server unavailable'
				: issues.every(issue => issue.scope === 'reminders') ? 'Files synced; reminders need attention' : 'Sync needs attention');
			this.errorIssuesEl.empty();
			renderSyncIssues(this.errorIssuesEl, issues, {
				serverUrl,
				fileActions: path => this.options.fileActions(path),
			});
		}
		this.errorNoticeEl.show();
	}

	dispose(): void {
		this.subtitleIndicatorRoot?.unmount();
		this.subtitleIndicatorRoot = undefined;
	}
}
