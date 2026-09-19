import { openRemoteRecoveryModal, type FileHistoryRuntime } from './remote-recovery-modal';
import { BaseUiModal } from './shared/BaseUiModal';
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
import { hideNativeModalCloseButton } from '../reminders/ui/adapters/modalShell';
import type { CrateSettings } from '../plugin/settings-types';
import type { ConflictRecord, SyncState, SyncActivityProgress } from '../sync/types';
import { renderHistoryPanel } from './activity/history';
import { renderConflictsPanel, renderPendingPanel } from './activity/panels';
import type { PendingDiffLoader, PendingBrowserState } from './activity/pending-browser';

export interface ActivityModalDeps extends Partial<FileHistoryRuntime> {
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
	private subtitleEl!: HTMLSpanElement;
	private errorNoticeEl!: HTMLDivElement;
	private errorMessageEl!: HTMLSpanElement;
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
			return;
		}
		this.updateSyncBtn();
		this.updateSyncStatusText();
		this.renderPending();
	};
	private renderPending(): void {
		const state = this.deps.getState();
        const progress = this.deps.getActivityProgress?.();
        const paths = this.deps.getPendingPaths();
        const loadingLabel = this.pendingPanel.querySelector('.crate-activity-loading-label');
        if (loadingLabel && (state.status === 'syncing' || progress)) {
            // Keep the spinner mounted through frequent progress updates.
            loadingLabel.textContent = formatSyncProgress(progress, state.work);
            return;
        }
        this.pendingBrowserState.dispose?.();
        this.pendingBrowserState.startChecks = undefined;
        this.pendingBrowserState.pauseChecks = undefined;
        this.pendingBrowserState.dispose = undefined;
        this.pendingPanel.empty();
		renderPendingPanel(this.pendingPanel, paths, state.status === 'error', state.status === 'syncing', progress, this.formatLastSync(), state,
			this.deps.loadPendingDiff ? (path, deleted) => this.deps.loadPendingDiff!(path, deleted) : undefined, this.pendingBrowserState,
            this.deps.syncSelected && this.deps.createPendingDiscard ? {
                syncSelected: async keys => {
                    try { return await this.deps.syncSelected!(keys); }
                    catch (error) { new Notice(error instanceof Error ? error.message : 'Could not sync selected files.'); throw error; }
                },
                fileActions: path => getPendingFileActions(this.app, path, () => this.close()),
                discard: keys => new PendingDiscardModal(this.app, () => this.deps.createPendingDiscard!(keys.filter(key => this.deps.getPendingPaths().includes(key))), () => this.refresh()).open(),
            } : undefined);
        this.updateSyncBtn();
	}
	private readonly onStateChange = () => {
		if (this.deps.getState().status === 'syncing' && this.pendingPanel?.querySelector('.crate-activity-loading-label')) this.onProgress();
		else this.refresh();
	};

	constructor(app: App, settings: CrateSettings, deps: ActivityModalDeps, private readonly initialTab: 'pending' | 'conflicts' | 'history' = 'pending') {
		super(app);
		this.settings = settings;
		this.deps = deps;
	}

	onOpen(): void {
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
			onMount: (container, close, header) => this.renderActivity(container, close, header),
		}));
	}

	private renderActivity(contentEl: HTMLDivElement, close: () => void, headerEl: HTMLDivElement): void {

		const header = headerEl.querySelector<HTMLElement>('.reminder-modal-header-side.is-right')!;

		this.subtitleEl = header.createSpan({ cls: 'crate-activity-subtitle', attr: { role: 'status' } });
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
		errorCopyEl.createSpan({ text: 'Sync error', cls: 'crate-sync-error-title' });
		this.errorMessageEl = errorCopyEl.createSpan({ cls: 'crate-sync-error-message' });
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
        this.updateSyncBtn();
        this.updateSyncStatusText();
	}

    private updateSyncStatusText(): void {
        const label = this.formatLastSync();
        const syncing = this.deps.getState().status === 'syncing' || !!this.deps.getActivityProgress?.();
        const status = this.deps.getState().status;
        const pending = this.deps.getPendingPaths().length;
        const needsAttention = status === 'error' || status === 'offline';
        const text = syncing
            ? formatSyncProgress(this.deps.getActivityProgress?.(), this.deps.getState().work)
            : needsAttention ? label
            : pending > 0 ? `${pending} ${pending === 1 ? 'change' : 'changes'} pending` : label;
        if (this.subtitleEl.textContent !== text) this.subtitleEl.setText(text);
        this.subtitleEl.setAttribute('title', text);
        this.subtitleEl.setAttribute('data-state', syncing ? 'syncing' : needsAttention ? 'attention' : pending > 0 ? 'pending' : label.startsWith('Synced') ? 'synced' : 'idle');
        if (this.deps.getActiveConflicts().length === 0) {
            this.conflictsPanel.empty();
            renderConflictsPanel(this.conflictsPanel, [], this.isCheckingConflicts());
        }
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

    private isCheckingConflicts(): boolean {
        const state = this.deps.getState();
        return (state.status === 'syncing' || !!this.deps.getActivityProgress?.())
            && !['saving', 'reminders'].includes(state.work?.phase ?? '');
    }

	private updateSyncBtn(): void {
		const syncing = this.deps.getState().status === 'syncing' || !!this.deps.getActivityProgress?.();
		const canStop = syncing && !!this.deps.stopSync;
		const label = this.stoppingSync ? 'Stopping…' : canStop ? 'Stop sync' : syncing ? 'Syncing…' : 'Sync vault';
		this.syncBtn.disabled = this.stoppingSync || (syncing && !canStop);
		this.syncBtn.hidden = false;
		this.syncBtn.setAttribute('aria-label', label);
		this.syncBtn.setAttribute('title', label === 'Sync vault' ? 'Sync all local and remote changes, including unchecked files.' : label);
		this.syncBtnLabel.setText(label);
		this.syncBtn.toggleClass('is-enabled', !this.syncBtn.disabled);

	}

	private updateSyncErrorNotice(): void {
		const state = this.deps.getState();
		if (state.status !== 'error') {
			this.errorNoticeEl.hide();
			return;
		}

		this.errorMessageEl.setText(state.lastError || 'An error occurred during sync.');
		this.errorNoticeEl.show();
	}

	private refresh(): void {
		const scrollContainer = this.historyPanel;
		const scrollTop = scrollContainer?.scrollTop ?? 0;
		this.updateSyncBtn();
		this.updateSyncErrorNotice();
		this.updateSyncStatusText();
		this.updateTabCounts();
		this.renderPending();
		this.conflictsPanel.empty();
		renderConflictsPanel(this.conflictsPanel, this.deps.getActiveConflicts(), this.isCheckingConflicts(), this.deps.createConflictReview ? conflict => {
			new ConflictReviewModal(this.app, conflict, () => this.deps.createConflictReview!(conflict), () => this.refresh()).open();
		} : undefined);
		const expanded = new Set(Array.from(this.historyPanel.querySelectorAll('details[open]'))
			.map((entry) => entry.getAttribute('data-history-key')));
		this.historyPanel.empty();
		const deps = this.deps;
		const historyRuntime = deps.listRecentFileVersions && deps.getPendingRestores && deps.loadFileHistoryPreview && deps.restoreRecentFileVersion && deps.loadCurrentSyncedPreview ? {
			loadCurrentSyncedPreview: deps.loadCurrentSyncedPreview.bind(deps),
			listRecentFileVersions: deps.listRecentFileVersions.bind(deps), getPendingRestores: deps.getPendingRestores.bind(deps),
			loadFileHistoryPreview: deps.loadFileHistoryPreview.bind(deps), restoreRecentFileVersion: deps.restoreRecentFileVersion.bind(deps),
		} : undefined;
		renderHistoryPanel(this.historyPanel, this.settings.syncHistory ?? [], historyRuntime ? path => {
			openRemoteRecoveryModal(this.app, historyRuntime, path);
		} : undefined);
		this.historyPanel.querySelectorAll('details').forEach((entry) => {
			entry.open = expanded.has(entry.getAttribute('data-history-key'));
		});
		if (scrollContainer) scrollContainer.scrollTop = scrollTop;
	}

	private formatLastSync(): string {
		if (this.deps.getActivityProgress?.()?.type === 'initial') return 'Uploading vault…';
		if (this.deps.getState().status === 'syncing' || this.deps.getActivityProgress?.()) return 'Syncing…';
		if (this.deps.getState().status === 'error') return 'Last sync had errors';
		if (this.deps.getState().status === 'offline') return 'Offline';
		const lastSync = this.deps.getState().lastSync;
		if (!lastSync) return 'Not synced yet';
		const diffMs = Date.now() - new Date(lastSync).getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return 'Synced just now';
		if (diffMin < 60) return `Synced ${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `Synced ${diffHr}h ago`;
		return `Synced ${Math.floor(diffHr / 24)}d ago`;
	}

	onClose(): void {
		this.pendingBrowserState.dispose?.();
		this.deps.removeStateChangeListener(this.onStateChange);
		this.deps.removeProgressListener?.(this.onProgress);
		this.tabsRoot?.unmount();
		this.tabsRoot = undefined;
		this.root?.unmount();
		this.root = undefined;
		this.contentEl.empty();
		this.contentEl.removeClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
	}
}
