import { SharedHistoryLoader } from './activity/shared-history-loader';
import { describeActivityStatus } from './activity/activity-status';
import type { SharedCheckpoint } from '../protocol/history-checkpoints';
import { mergeSharedHistory } from './activity/shared-history';
import { openRemoteRecoveryModal, type FileHistoryRuntime } from './remote-recovery-modal';
import { BaseUiModal } from './plugin/BaseUiModal';
import { getPendingFileActions } from './activity/file-actions';
import type { PendingDiscardReview } from '../sync/pending-discard';
import { PendingDiscardModal } from './activity/pending-discard-modal';
import { formatSyncProgress } from './activity/progress-label';
import type { ConflictReview } from '../sync/conflict-review';
import { ConflictReviewModal } from './activity/conflict-review-modal';
import { Notice, Platform, setIcon, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActivitySheet } from './activity/ActivitySheet';
import { ActivityTabs } from './activity/ActivityTabs';
import { StatusBarIndicator } from './StatusBarIndicator';
import { hideNativeModalCloseButton } from './plugin/modalShell';
import type { CrateSettings } from '../plugin/settings-types';
import type { ConflictRecord, SyncState, SyncActivityProgress } from '../sync/types';
import { ActivityHistory } from './activity/activity-history';
import type { HistoryComparison } from '../sync/history-comparison';
import { HistoryRestoreModal } from './activity/history-restore-modal';
import type { HistoryRestoreReview } from '../sync/history-restore';
import type { SyncHistoryEntry } from '../sync/types';
import { renderConflictsPanel, renderPendingPanel } from './activity/panels';
import { renderLoadingState } from './activity/rendering';
import type { PendingDiffLoader, PendingBrowserState } from './activity/pending-browser';
import { renderSyncIssues } from './activity/sync-issues';

export interface ActivityModalDeps extends Partial<FileHistoryRuntime> {
    loadHistoryComparison?(entry: SyncHistoryEntry): Promise<HistoryComparison>;
    listSharedCheckpoints?(): Promise<SharedCheckpoint[]>;
    createHistoryRestore?(entry: SyncHistoryEntry): Promise<HistoryRestoreReview>;
	loadPendingDiff?: PendingDiffLoader;
    syncSelected?(keys: string[]): Promise<unknown>;
    createPendingDiscard?(keys: string[]): Promise<PendingDiscardReview>;
	createConflictReview?(record: ConflictRecord): Promise<ConflictReview>;
	getPendingPaths(): string[];
	getActiveConflicts(): ConflictRecord[];
	getState(): SyncState;
	getActivityProgress?(): SyncActivityProgress | null;
	addProgressListener?(listener: (current: number, total: number) => void): void;
	removeProgressListener?(listener: (current: number, total: number) => void): void;
	sync(): Promise<unknown>;
	stopSync?(): Promise<void>;
	addStateChangeListener(listener: (state: SyncState) => void): void;
	removeStateChangeListener(listener: (state: SyncState) => void): void;
}

export class ActivityModal extends BaseUiModal {
	private root: Root | undefined;
	private readonly settings: CrateSettings;
	private readonly deps: ActivityModalDeps;
	private tabsRoot: Root | undefined;
	private currentTabIndex = 0;
    private activityHistory?: ActivityHistory;
    private sharedHistory?: SharedHistoryLoader;
	private subtitleEl!: HTMLSpanElement;
	private subtitleLabelEl!: HTMLSpanElement;
	private subtitleIndicatorRoot: Root | undefined;
	private errorNoticeEl!: HTMLDivElement;
	private errorIssuesEl!: HTMLDivElement;
	private errorSignature = '';
	private errorTitleEl!: HTMLSpanElement;
	private syncBtn!: HTMLButtonElement;
	private syncBtnLabel!: HTMLSpanElement;
	private stoppingSync = false;
	private pendingCount!: HTMLSpanElement;
	private conflictsCount!: HTMLSpanElement;
	private pendingPanel!: HTMLDivElement;
	private readonly pendingBrowserState: PendingBrowserState = {};
	private conflictsPanel!: HTMLDivElement;
	private historyPanel!: HTMLDivElement;
	private readonly onProgress = () => {
		if (!this.pendingPanel) return;
		// Manual sync records history after the engine's final state event.
		// Its completion progress event must refresh history as well as pending files.
		if (this.deps.getState().status !== 'syncing' && !this.deps.getActivityProgress?.()) {
			this.refresh();
            if (this.currentTabIndex === 2) void this.sharedHistory?.refresh();
			return;
		}
		this.updateSyncBtn();
		this.updateSyncStatusText();
        if (this.deps.getActiveConflicts().length === 0) this.renderConflicts();
		this.renderPending();
	};
	private renderPending(): void {
		const state = this.deps.getState();
        const progress = this.deps.getActivityProgress?.();
        const paths = this.deps.getPendingPaths();
        const loadingLabel = this.pendingPanel.querySelector('.crate-activity-loading-label');
        if (loadingLabel && (state.status === 'syncing' || progress)) {
            // Keep the spinner mounted through frequent progress updates.
            const text = formatSyncProgress(progress, state.work);
            if (loadingLabel.textContent !== text) loadingLabel.textContent = text;
            loadingLabel.setAttribute('title', text);
            return;
        }
        this.pendingBrowserState.dispose?.();
        this.pendingBrowserState.startChecks = undefined;
        this.pendingBrowserState.pauseChecks = undefined;
        this.pendingBrowserState.dispose = undefined;
        this.pendingPanel.empty();
		renderPendingPanel(this.pendingPanel, paths, state.status === 'error', state.status === 'syncing', progress, this.getActivityStatus().lastSyncLabel, state,
			this.deps.loadPendingDiff ? (path, deleted) => this.deps.loadPendingDiff!(path, deleted) : undefined, this.pendingBrowserState,
            this.deps.syncSelected && this.deps.createPendingDiscard ? {
                syncSelected: async keys => {
                    try { return await this.deps.syncSelected!(keys); }
                    catch (error) { new Notice(error instanceof Error ? error.message : 'Could not sync selected files.'); throw error; }
                },
                fileActions: path => getPendingFileActions(this.app, path, () => this.close()),
                discard: keys => new PendingDiscardModal(this.app, () => this.deps.createPendingDiscard!(keys.filter(key => this.deps.getPendingPaths().includes(key))), () => this.refresh(), keys.map(key => key.startsWith('delete:') ? key.slice(7) : key)).open(),
            } : undefined);
        this.updateSyncBtn();
	}
	private readonly onStateChange = () => {
		if (this.deps.getState().status === 'syncing' && this.pendingPanel?.querySelector('.crate-activity-loading-label')) this.onProgress();
		else {
            this.refresh();
            if (this.currentTabIndex === 2 && this.deps.getState().status !== 'syncing') void this.sharedHistory?.refresh();
        }
	};

	constructor(app: App, settings: CrateSettings, deps: ActivityModalDeps, private readonly initialTab: 'pending' | 'conflicts' | 'history' = 'pending') {
		super(app);
		this.settings = settings;
		this.deps = deps;
	}

	onOpen(): void {
        if (this.deps.listSharedCheckpoints) {
            this.sharedHistory = new SharedHistoryLoader(() => this.deps.listSharedCheckpoints!(), () => this.refresh());
        }
		this.modalEl.addClass('crate-reminder-editor-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		hideNativeModalCloseButton(this.modalEl);
		this.contentEl.addClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
		this.root = createRoot(this.contentEl);
		this.root.render(createElement(ActivitySheet, {
			isMobile: Platform.isMobile,
			// Motion uses the main window's animation loop, which can pause while
			// Obsidian's separate Settings window is active.
			animationsEnabled: this.contentEl.win === window,
			onClose: () => this.close(),
			onMount: (container, _close, header) => this.renderActivity(container, header),
		}));
	}

	private renderActivity(contentEl: HTMLDivElement, headerEl: HTMLDivElement): void {

		const header = headerEl.querySelector<HTMLElement>('.reminder-modal-header-side.is-right')!;

		this.subtitleEl = header.createSpan({ cls: 'crate-activity-subtitle', attr: { role: 'status' } });
		this.subtitleIndicatorRoot = createRoot(this.subtitleEl.createSpan({ cls: 'crate-activity-subtitle-indicator' }));
		this.subtitleLabelEl = this.subtitleEl.createSpan({ cls: 'crate-activity-subtitle-label' });
		this.syncBtn = header.createEl('button', {
			cls: 'crate-sync-now-btn crate-sync-primary-action reminder-modal-header-action',
			attr: { type: 'button', 'aria-label': 'Sync vault', title: 'Sync all local and remote changes, including unchecked files.' },
		});
		this.syncBtnLabel = this.syncBtn.createSpan({ cls: 'reminder-modal-header-action-label' });
		this.syncBtn.addEventListener('click', () => {
			if (this.deps.stopSync && (this.deps.getState().status === 'syncing' || this.deps.getActivityProgress?.())) {
				this.stoppingSync = true;
				this.updateSyncBtn();
				void this.deps.stopSync()
					.then(() => { new Notice('Sync stopped. Automatic sync is off on this device.'); })
					.catch(error => { new Notice(error instanceof Error ? error.message : 'Could not stop sync.'); })
					.finally(() => { this.stoppingSync = false; this.updateSyncBtn(); });
			} else {
				void this.deps.sync().catch(error => { new Notice(error instanceof Error ? error.message : 'Could not sync.'); });
			}
		});
		this.updateSyncBtn();

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


        const tabsHost = contentEl.createDiv({ cls: 'crate-activity-tabs-host' });
        this.tabsRoot = createRoot(tabsHost);
        this.tabsRoot.render(createElement(ActivityTabs, {
            initialTab: this.initialTab,
            onTabChange: index => this.switchTab(index),
            onMount: elements => {
                this.pendingPanel = elements.pending;
                this.conflictsPanel = elements.conflicts;
                this.historyPanel = elements.history;
                this.pendingCount = elements.pendingCount;
                this.conflictsCount = elements.conflictsCount;
                this.refresh();
                this.switchTab(this.initialTab === 'history' ? 2 : this.initialTab === 'conflicts' ? 1 : 0);
                this.deps.addStateChangeListener(this.onStateChange);
                this.deps.addProgressListener?.(this.onProgress);
            },
        }));
    }

	private switchTab(index: number): void {
		if (index === 0) this.pendingBrowserState.startChecks?.();
		else this.pendingBrowserState.pauseChecks?.();
		this.currentTabIndex = index;
        if (index === 2) { this.renderHistory(); void this.sharedHistory?.refresh(); }
        this.updateSyncBtn();
        this.updateSyncStatusText();
	}

    private getActivityStatus() {
        return describeActivityStatus(this.deps.getState(), this.deps.getActivityProgress?.() ?? null,
            this.deps.getPendingPaths().length, !!this.deps.stopSync, this.stoppingSync);
    }

    private updateSyncStatusText(): void {
        const status = this.getActivityStatus();
        if (this.subtitleLabelEl.textContent !== status.text) this.subtitleLabelEl.setText(status.text);
        this.subtitleIndicatorRoot?.render(createElement(StatusBarIndicator, { state: status.indicatorState }));
        this.subtitleEl.setAttribute('title', status.text);
        this.subtitleEl.setAttribute('data-state', status.subtitleState);
    }


	private updateTabCounts(): void {
		const pendingLen = this.deps.getPendingPaths().length;
		const conflictLen = this.deps.getActiveConflicts().length;

		this.pendingCount.setText(pendingLen > 0 ? String(pendingLen) : '');
		this.conflictsCount.setText(conflictLen > 0 ? String(conflictLen) : '');

		if (conflictLen > 0) {
			this.conflictsCount.addClass('crate-tab-count-warning');
		} else {
			this.conflictsCount.removeClass('crate-tab-count-warning');
		}
	}

	private updateSyncBtn(): void {
		const button = this.getActivityStatus().button;
		this.syncBtn.disabled = button.disabled;
		this.syncBtn.hidden = false;
		this.syncBtn.setAttribute('aria-label', button.label);
		this.syncBtn.setAttribute('title', button.title);
		this.syncBtnLabel.setText(button.label);
		this.syncBtn.toggleClass('is-enabled', !button.disabled);
	}

	private updateSyncErrorNotice(): void {
		const state = this.deps.getState();
		if (state.status !== 'error' && state.status !== 'offline') {
			this.errorNoticeEl.hide();
			return;
		}

		const issues = state.lastIssues?.length ? state.lastIssues : [{ message: state.lastError || 'Cannot reach the sync server.' }];
		const signature = JSON.stringify([state.status, issues, this.settings.workerUrl]);
		if (signature !== this.errorSignature) {
			this.errorSignature = signature;
			this.errorTitleEl.setText(state.status === 'offline' ? 'Server unavailable'
				: issues.every(issue => issue.scope === 'reminders') ? 'Files synced; reminders need attention' : 'Sync needs attention');
			this.errorIssuesEl.empty();
			renderSyncIssues(this.errorIssuesEl, issues, {
				serverUrl: this.settings.workerUrl,
				fileActions: path => getPendingFileActions(this.app, path, () => this.close()),
			});
		}
		this.errorNoticeEl.show();
	}

	private refresh(): void {
		this.updateSyncBtn();
		this.updateSyncErrorNotice();
		this.updateSyncStatusText();
		this.updateTabCounts();
		this.renderPending();
        this.renderConflicts();
        if (this.currentTabIndex === 2) this.renderHistory();
    }

    private renderConflicts(): void {
		this.conflictsPanel.empty();
		renderConflictsPanel(this.conflictsPanel, this.deps.getActiveConflicts(), this.getActivityStatus().checkingConflicts, this.deps.createConflictReview ? conflict => {
			new ConflictReviewModal(this.app, conflict, () => this.deps.createConflictReview!(conflict), () => this.refresh()).open();
		} : undefined);
    }

    private renderHistory(): void {
        const deps = this.deps;
        if (this.sharedHistory && !this.sharedHistory.getSnapshot().ready) {
            if (!this.historyPanel.firstChild) {
                renderLoadingState(this.historyPanel, 'Loading history…');
            }
            return;
        }
        if (!this.activityHistory) {
            this.historyPanel.empty();
            const historyRuntime = deps.listRecentFileVersions && deps.getPendingRestores && deps.loadFileHistoryPreview && deps.restoreRecentFileVersion && deps.loadCurrentSyncedPreview ? {
                loadCurrentSyncedPreview: deps.loadCurrentSyncedPreview.bind(deps),
                listRecentFileVersions: deps.listRecentFileVersions.bind(deps), getPendingRestores: deps.getPendingRestores.bind(deps),
                loadFileHistoryPreview: deps.loadFileHistoryPreview.bind(deps), restoreRecentFileVersion: deps.restoreRecentFileVersion.bind(deps),
            } : undefined;
            this.activityHistory = new ActivityHistory(this.app, this.historyPanel, {
                load: deps.loadHistoryComparison?.bind(deps),
                openFile: historyRuntime ? path => openRemoteRecoveryModal(this.app, historyRuntime, path) : undefined,
                restore: deps.createHistoryRestore ? entry => {
                    new HistoryRestoreModal(this.app, entry, () => deps.createHistoryRestore!(entry), () => this.refresh()).open();
                } : undefined,
            }, () => this.close());
        }
        const checkpoints = this.sharedHistory?.getSnapshot().checkpoints;
        this.activityHistory.update(checkpoints ? mergeSharedHistory(this.settings.syncHistory ?? [], checkpoints) : this.settings.syncHistory ?? []);
    }

	onClose(): void {
        this.sharedHistory?.dispose();
        this.sharedHistory = undefined;
        this.activityHistory?.dispose();
        this.activityHistory = undefined;
		this.pendingBrowserState.dispose?.();
		this.deps.removeStateChangeListener(this.onStateChange);
		this.deps.removeProgressListener?.(this.onProgress);
		this.subtitleIndicatorRoot?.unmount();
		this.subtitleIndicatorRoot = undefined;
		this.tabsRoot?.unmount();
		this.tabsRoot = undefined;
		this.root?.unmount();
		this.root = undefined;
		this.contentEl.empty();
		this.contentEl.removeClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
	}
}
