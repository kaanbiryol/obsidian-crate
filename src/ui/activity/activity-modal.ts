import { SharedHistoryLoader } from './shared-history-loader';
import { describeActivityStatus } from './activity-status';
import type { SharedCheckpoint } from '../../protocol/history-checkpoints';
import { mergeSharedHistory } from './shared-history';
import { openFileHistoryModal, type FileHistoryRuntime } from './file-history-modal';
import { BaseUiModal } from '../plugin/BaseUiModal';
import { getPendingFileActions } from './file-actions';
import type { PendingDiscardReview } from '../../sync/pending/pending-discard';
import { PendingDiscardModal } from './pending-discard-modal';
import { formatSyncProgress } from './progress-label';
import type { ConflictReview } from '../../sync/conflict/review';
import { ConflictReviewModal } from './conflict-review-modal';
import { Notice, Platform, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActivitySheet } from './ActivitySheet';
import { ActivityTabs } from './ActivityTabs';
import { ActivityHeader } from './activity-header';
import { hideNativeModalCloseButton } from '../plugin/shared-modal';
import type { CrateSettings } from '../../plugin/settings-types';
import type { ConflictRecord, SyncState, SyncActivityProgress } from '../../sync/types';
import { ActivityHistory } from './activity-history';
import type { HistoryComparison } from '../../sync/history/comparison';
import { HistoryRestoreModal } from './history-restore-modal';
import type { HistoryRestoreReview } from '../../sync/history/restore';
import type { SyncHistoryEntry } from '../../sync/types';
import { renderConflictsPanel, renderPendingPanel } from './panels';
import { renderLoadingState } from './rendering';
import type { PendingDiffLoader, PendingBrowserState } from './pending-browser';

export interface ActivityModalDeps extends FileHistoryRuntime {
	loadHistoryComparison(entry: SyncHistoryEntry): Promise<HistoryComparison>;
	listSharedCheckpoints(): Promise<SharedCheckpoint[]>;
	createHistoryRestore(entry: SyncHistoryEntry): Promise<HistoryRestoreReview>;
	loadPendingDiff: PendingDiffLoader;
	syncSelected(keys: string[]): Promise<unknown>;
	createPendingDiscard(keys: string[]): Promise<PendingDiscardReview>;
	createConflictReview(record: ConflictRecord): Promise<ConflictReview>;
	getPendingKeys(): string[];
	/** Pending count without copying the pending list on every progress tick. */
	getPendingChangeCount(): number;
	hasPendingKey(key: string): boolean;
	getActiveConflicts(): ConflictRecord[];
	getState(): SyncState;
	getActivityProgress(): SyncActivityProgress | null;
	addProgressListener(listener: (current: number, total: number) => void): void;
	removeProgressListener(listener: (current: number, total: number) => void): void;
	sync(): Promise<unknown>;
	stopSync(): Promise<void>;
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
	private header!: ActivityHeader;
	private stoppingSync = false;
	private pendingCount!: HTMLSpanElement;
	private conflictsCount!: HTMLSpanElement;
	private pendingPanel!: HTMLDivElement;
	private readonly pendingBrowserState: PendingBrowserState = {};
	private conflictsPanel!: HTMLDivElement;
	private renderedConflicts: string | undefined;
	private historyPanel!: HTMLDivElement;
	private closed = false;
	private clock: number | undefined;
	private updateScheduled = false;
	private stateChanged = false;
	private renderedBrowserPaths: string[] | undefined;
	// A file's state change and progress tick arrive together; apply them once.
	private scheduleUpdate(stateChanged: boolean): void {
		this.stateChanged ||= stateChanged;
		if (this.updateScheduled) return;
		this.updateScheduled = true;
		queueMicrotask(() => {
			this.updateScheduled = false;
			const changed = this.stateChanged;
			this.stateChanged = false;
			if (this.closed || !this.pendingPanel) return;
			if (changed) this.applyStateChange();
			else this.applyProgress();
		});
	}
	private readonly onProgress = () => this.scheduleUpdate(false);
	private readonly onStateChange = () => this.scheduleUpdate(true);
	private applyProgress(): void {
		if (!this.pendingPanel) return;
		const state = this.deps.getState();
		// Manual sync records history after the engine's final state event.
		// Its completion progress event must refresh history as well as pending files.
		if (state.status !== 'syncing' && !(state.initializing && state.status === 'idle') && !this.deps.getActivityProgress()) {
			this.refresh();
			if (this.currentTabIndex === 2) void this.sharedHistory?.refresh();
			return;
		}
		const status = this.getActivityStatus();
		this.header.updateSyncBtn(status);
		this.header.updateSyncStatusText(status);
		this.renderConflicts(status);
		this.renderPending();
	}
	private renderPending(): void {
		const state = this.deps.getState();
		const progress = this.deps.getActivityProgress();
		const loadingLabel = this.pendingPanel.querySelector('.crate-activity-loading-label');
		if (loadingLabel && (state.status === 'syncing' || progress || state.initializing && state.status === 'idle')) {
			// Keep the spinner mounted through frequent progress updates.
			const text = state.status === 'syncing' || progress ? formatSyncProgress(progress, state.work) : 'Checking local files…';
			if (loadingLabel.textContent !== text) loadingLabel.textContent = text;
			loadingLabel.setAttribute('title', text);
			return;
		}
		const paths = this.deps.getPendingKeys();
		// Rebuilding the file browser discards its comparisons; keep it while the pending set is unchanged.
		const showsBrowser = paths.length > 0 && state.status !== 'syncing' && !progress
			&& !(state.initializing && state.status !== 'error' && state.status !== 'offline');
		const rendered = this.renderedBrowserPaths;
		if (showsBrowser && rendered?.length === paths.length && rendered.every((key, index) => key === paths[index])
			&& this.pendingPanel.querySelector('.crate-pending-browser')) {
			this.header.updateSyncBtn();
			return;
		}
		this.renderedBrowserPaths = showsBrowser ? paths : undefined;
		this.pendingBrowserState.dispose?.();
		this.pendingBrowserState.startChecks = undefined;
		this.pendingBrowserState.pauseChecks = undefined;
		this.pendingBrowserState.dispose = undefined;
		this.pendingPanel.empty();
		renderPendingPanel(this.pendingPanel, paths, (path, deleted) => this.deps.loadPendingDiff(path, deleted), state.status === 'error', state.status === 'syncing',
			progress, this.getActivityStatus().lastSyncLabel, state, this.pendingBrowserState, {
				syncSelected: async keys => {
					try { return await this.deps.syncSelected(keys); }
					catch (error) { new Notice(error instanceof Error ? error.message : 'Could not sync selected files.'); throw error; }
				},
				fileActions: path => getPendingFileActions(this.app, path, () => this.close()),
				discard: keys => new PendingDiscardModal(this.app, () => this.deps.createPendingDiscard(keys.filter(key => this.deps.hasPendingKey(key))), () => this.refresh()).open(),
			});
		this.header.updateSyncBtn();
	}
	private applyStateChange(): void {
		const state = this.deps.getState();
		if ((state.status === 'syncing' || state.initializing && state.status === 'idle')
			&& this.pendingPanel?.querySelector('.crate-activity-loading-label')) this.applyProgress();
		else {
			this.refresh();
			if (this.currentTabIndex === 2 && this.deps.getState().status !== 'syncing') void this.sharedHistory?.refresh();
		}
	}

	constructor(app: App, settings: CrateSettings, deps: ActivityModalDeps, private readonly initialTab: 'pending' | 'conflicts' | 'history' = 'pending') {
		super(app);
		this.settings = settings;
		this.deps = deps;
	}

	onOpen(): void {
		this.closed = false;
		// "Synced 5m ago" ages without runtime events.
		this.clock = window.setInterval(() => this.scheduleUpdate(true), 60_000);
		this.sharedHistory = new SharedHistoryLoader(() => this.deps.listSharedCheckpoints(), () => this.refresh());
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
		this.header = this.createHeader(headerEl.querySelector<HTMLElement>('.reminder-modal-header-side.is-right')!, contentEl);

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
				this.renderedConflicts = undefined;
				this.refresh();
				this.switchTab(this.initialTab === 'history' ? 2 : this.initialTab === 'conflicts' ? 1 : 0);
				this.deps.addStateChangeListener(this.onStateChange);
				this.deps.addProgressListener(this.onProgress);
			},
		}));
	}

	private createHeader(header: HTMLElement, contentEl: HTMLElement): ActivityHeader {
		return new ActivityHeader(header, contentEl, {
			getStatus: () => this.getActivityStatus(),
			getState: () => this.deps.getState(),
			getServerUrl: () => this.settings.workerUrl,
			fileActions: path => getPendingFileActions(this.app, path, () => this.close()),
			onSync: () => this.toggleSync(),
		});
	}

	private toggleSync(): void {
		if (this.deps.getState().status === 'syncing' || this.deps.getActivityProgress()) {
			this.stoppingSync = true;
			this.header.updateSyncBtn();
			void this.deps.stopSync()
				.then(() => { new Notice('Sync stopped. Automatic sync is off on this device.'); })
				.catch(error => { new Notice(error instanceof Error ? error.message : 'Could not stop sync.'); })
				.finally(() => { this.stoppingSync = false; this.header.updateSyncBtn(); });
		} else {
			void this.deps.sync().catch(error => { new Notice(error instanceof Error ? error.message : 'Could not sync.'); });
		}
	}

	private switchTab(index: number): void {
		if (index === 0) this.pendingBrowserState.startChecks?.();
		else this.pendingBrowserState.pauseChecks?.();
		this.currentTabIndex = index;
		if (index === 2) { this.renderHistory(); void this.sharedHistory?.refresh(); }
		this.header.updateSyncBtn();
		this.header.updateSyncStatusText();
	}

	private getActivityStatus() {
		return describeActivityStatus(this.deps.getState(), this.deps.getActivityProgress(),
			this.deps.getPendingChangeCount(), true, this.stoppingSync);
	}

	private updateTabCounts(): void {
		const pendingLen = this.deps.getPendingChangeCount();
		const conflictLen = this.deps.getActiveConflicts().length;

		this.pendingCount.setText(pendingLen > 0 ? String(pendingLen) : '');
		this.conflictsCount.setText(conflictLen > 0 ? String(conflictLen) : '');

		if (conflictLen > 0) {
			this.conflictsCount.addClass('crate-tab-count-warning');
		} else {
			this.conflictsCount.removeClass('crate-tab-count-warning');
		}
	}

	private refresh(): void {
		this.header.updateSyncBtn();
		this.header.updateSyncErrorNotice();
		this.header.updateSyncStatusText();
		this.updateTabCounts();
		this.renderPending();
		this.renderConflicts();
		if (this.currentTabIndex === 2) this.renderHistory();
	}

	private renderConflicts(status = this.getActivityStatus()): void {
		const conflicts = this.deps.getActiveConflicts();
		// Rebuilding an unchanged panel would drop keyboard focus on its Review buttons.
		const rendered = JSON.stringify(conflicts.length ? conflicts : status.checkingConflicts);
		if (rendered === this.renderedConflicts) return;
		this.renderedConflicts = rendered;
		this.conflictsPanel.empty();
		renderConflictsPanel(this.conflictsPanel, conflicts, status.checkingConflicts, conflict => {
			new ConflictReviewModal(this.app, conflict, () => this.deps.createConflictReview(conflict), () => this.refresh()).open();
		});
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
			this.activityHistory = new ActivityHistory(this.app, this.historyPanel, {
				load: deps.loadHistoryComparison.bind(deps),
				openFile: path => openFileHistoryModal(this.app, deps, path),
				restore: entry => {
					new HistoryRestoreModal(this.app, entry, () => deps.createHistoryRestore(entry), () => this.refresh()).open();
				},
			}, () => this.close());
		}
		const checkpoints = this.sharedHistory?.getSnapshot().checkpoints;
		this.activityHistory.update(checkpoints ? mergeSharedHistory(this.settings.syncHistory ?? [], checkpoints) : this.settings.syncHistory ?? []);
	}

	onClose(): void {
		this.closed = true;
		window.clearInterval(this.clock);
		this.sharedHistory?.dispose();
		this.sharedHistory = undefined;
		this.activityHistory?.dispose();
		this.activityHistory = undefined;
		this.pendingBrowserState.dispose?.();
		this.deps.removeStateChangeListener(this.onStateChange);
		this.deps.removeProgressListener(this.onProgress);
		this.header?.dispose();
		this.tabsRoot?.unmount();
		this.tabsRoot = undefined;
		this.root?.unmount();
		this.root = undefined;
		this.contentEl.empty();
		this.contentEl.removeClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
	}
}
