import { Modal, setIcon, type App } from 'obsidian';
import type { CrateSettings } from '../plugin/settings-types';
import type { ConflictRecord, SyncState } from '../sync/types';
import { renderHistoryPanel } from './activity/history';
import { renderConflictsPanel, renderPendingPanel } from './activity/panels';

export interface ActivityModalDeps {
	getPendingPaths(): string[];
	getActiveConflicts(): ConflictRecord[];
	getState(): SyncState;
	sync(): Promise<unknown>;
	addStateChangeListener(listener: (state: SyncState) => void): void;
	removeStateChangeListener(listener: (state: SyncState) => void): void;
}

export class ActivityModal extends Modal {
	private readonly settings: CrateSettings;
	private readonly deps: ActivityModalDeps;
	private tabIndicator!: HTMLDivElement;
	private subtitleEl!: HTMLSpanElement;
	private errorNoticeEl!: HTMLDivElement;
	private errorMessageEl!: HTMLSpanElement;
	private syncBtn!: HTMLButtonElement;
	private syncBtnIcon!: HTMLSpanElement;
	private pendingCount!: HTMLSpanElement;
	private conflictsCount!: HTMLSpanElement;
	private pendingPanel!: HTMLDivElement;
	private conflictsPanel!: HTMLDivElement;
	private allTabs: HTMLElement[] = [];
	private allPanels: HTMLDivElement[] = [];
	private currentTabIndex = 0;
	private readonly onStateChange = () => this.refresh();

	constructor(app: App, settings: CrateSettings, deps: ActivityModalDeps) {
		super(app);
		this.settings = settings;
		this.deps = deps;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('crate-activity-modal');

		// Header
		const header = contentEl.createDiv({ cls: 'crate-activity-header' });
		const headerText = header.createDiv({ cls: 'crate-activity-header-text' });
		headerText.createEl('h3', { text: 'Sync activity', cls: 'crate-activity-title' });
		this.subtitleEl = headerText.createSpan({ text: this.formatLastSync(), cls: 'crate-activity-subtitle' });

		this.syncBtn = header.createEl('button', { cls: 'crate-sync-now-btn' });
		this.syncBtnIcon = this.syncBtn.createSpan({ cls: 'crate-sync-btn-icon' });
		setIcon(this.syncBtnIcon, 'refresh-cw');
		this.syncBtn.createSpan({ text: 'Sync now', cls: 'crate-sync-btn-text' });
		this.syncBtn.addEventListener('click', () => {
			void this.deps.sync();
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

		// Tab bar
		const tabBar = contentEl.createDiv({ cls: 'crate-activity-tab-bar' });
		const tabs = tabBar.createDiv({ cls: 'crate-activity-tabs' });

		const pendingTab = tabs.createDiv({ cls: 'crate-activity-tab crate-activity-tab-active', attr: { tabindex: '0', role: 'tab' } });
		pendingTab.createSpan({ text: 'Pending' });
		this.pendingCount = pendingTab.createSpan({ cls: 'crate-tab-count' });

		const conflictsTab = tabs.createDiv({ cls: 'crate-activity-tab', attr: { tabindex: '0', role: 'tab' } });
		conflictsTab.createSpan({ text: 'Conflicts' });
		this.conflictsCount = conflictsTab.createSpan({ cls: 'crate-tab-count' });

		const historyTab = tabs.createDiv({ cls: 'crate-activity-tab', attr: { tabindex: '0', role: 'tab' } });
		historyTab.createSpan({ text: 'History' });

		this.tabIndicator = tabs.createDiv({ cls: 'crate-activity-tab-indicator' });

		this.updateTabCounts();

		// Panels
		this.pendingPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		this.conflictsPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		const historyPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		this.conflictsPanel.hide();
		historyPanel.hide();

		this.allTabs = [pendingTab, conflictsTab, historyTab];
		this.allPanels = [this.pendingPanel, this.conflictsPanel, historyPanel];

		renderPendingPanel(this.pendingPanel, this.deps.getPendingPaths());
		renderConflictsPanel(this.conflictsPanel, this.deps.getActiveConflicts());
		renderHistoryPanel(historyPanel, this.settings.syncHistory ?? []);

		for (let i = 0; i < this.allTabs.length; i++) {
			const tab = this.allTabs[i];
			if (!tab) continue;
			tab.addEventListener('click', () => this.switchTab(i));
		}

		this.deps.addStateChangeListener(this.onStateChange);

		// Position indicator after layout
		this.contentEl.win.requestAnimationFrame(() => this.positionIndicator(0));
	}

	private switchTab(index: number): void {
		this.currentTabIndex = index;
		for (let i = 0; i < this.allTabs.length; i++) {
			const tab = this.allTabs[i];
			const panel = this.allPanels[i];
			if (!tab || !panel) continue;
			if (i === index) {
				tab.addClass('crate-activity-tab-active');
				panel.show();
			} else {
				tab.removeClass('crate-activity-tab-active');
				panel.hide();
			}
		}
		this.positionIndicator(index);
	}

	private positionIndicator(index: number): void {
		const tab = this.allTabs[index];
		if (!tab) return;
		this.tabIndicator.style.left = `${tab.offsetLeft}px`;
		this.tabIndicator.style.width = `${tab.offsetWidth}px`;
	}

	private updateTabCounts(): void {
		const pendingLen = this.deps.getPendingPaths().length;
		const conflictLen = this.deps.getActiveConflicts().length;

		this.pendingCount.setText(pendingLen > 0 ? `(${pendingLen})` : '');
		this.conflictsCount.setText(conflictLen > 0 ? `(${conflictLen})` : '');

		if (conflictLen > 0) {
			this.conflictsCount.addClass('crate-tab-count-warning');
		} else {
			this.conflictsCount.removeClass('crate-tab-count-warning');
		}
	}

	private updateSyncBtn(): void {
		const syncing = this.deps.getState().status === 'syncing';
		this.syncBtn.disabled = syncing;
		if (syncing) {
			this.syncBtn.addClass('is-syncing');
		} else {
			this.syncBtn.removeClass('is-syncing');
		}
		const textEl = this.syncBtn.querySelector('.crate-sync-btn-text');
		if (textEl) textEl.textContent = syncing ? 'Syncing...' : 'Sync now';
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
		this.updateSyncBtn();
		this.updateSyncErrorNotice();
		this.subtitleEl.setText(this.formatLastSync());
		this.updateTabCounts();
		this.pendingPanel.empty();
		renderPendingPanel(this.pendingPanel, this.deps.getPendingPaths());
		this.conflictsPanel.empty();
		renderConflictsPanel(this.conflictsPanel, this.deps.getActiveConflicts());
		this.contentEl.win.requestAnimationFrame(() => this.positionIndicator(this.currentTabIndex));
	}

	private formatLastSync(): string {
		const lastSync = this.deps.getState().lastSync;
		if (!lastSync) return 'Never synced';
		const diffMs = Date.now() - new Date(lastSync).getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return 'Last synced just now';
		if (diffMin < 60) return `Last synced ${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `Last synced ${diffHr}h ago`;
		return `Last synced ${Math.floor(diffHr / 24)}d ago`;
	}

	onClose(): void {
		this.deps.removeStateChangeListener(this.onStateChange);
		this.contentEl.empty();
	}
}
