import { Modal, Platform, setIcon, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActivitySheet } from './activity/ActivitySheet';
import { hideNativeModalCloseButton } from '../reminders/ui/adapters/modalShell';
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

let nextActivityId = 0;

export class ActivityModal extends Modal {
    // Obsidian's native Modal.open() otherwise focuses the first control after
    // onOpen(). The shared sheet owns initial focus instead (Obsidian 1.13+).
    hasInitialInputFocus = false;
	private readonly tabIdPrefix = `crate-activity-${++nextActivityId}`;
	private root: Root | undefined;
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
	private historyPanel!: HTMLDivElement;
	private allTabs: HTMLButtonElement[] = [];
	private allPanels: HTMLDivElement[] = [];
	private currentTabIndex = 0;
	private readonly onStateChange = () => this.refresh();

	constructor(app: App, settings: CrateSettings, deps: ActivityModalDeps) {
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
			onClose: () => this.close(),
			onMount: (container, close) => this.renderActivity(container, close),
		}));
	}

	private renderActivity(contentEl: HTMLDivElement, close: () => void): void {
		this.currentTabIndex = 0;

		// Header
		const header = contentEl.createDiv({ cls: 'crate-activity-header' });
		const closeButton = header.createEl('button', {
			cls: 'crate-activity-close-btn',
			attr: { type: 'button', 'aria-label': 'Close sync activity', title: 'Close' },
		});
		setIcon(closeButton, 'x');
		closeButton.addEventListener('click', close);

		const headerText = header.createDiv({ cls: 'crate-activity-header-text' });
		headerText.createEl('h2', { text: 'Sync activity', cls: 'crate-activity-title' });
		this.subtitleEl = headerText.createSpan({ text: this.formatLastSync(), cls: 'crate-activity-subtitle' });

		this.syncBtn = header.createEl('button', {
			cls: 'crate-sync-now-btn',
			attr: { type: 'button', 'aria-label': 'Sync now', title: 'Sync now' },
		});
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
		const tabs = tabBar.createDiv({ cls: 'crate-activity-tabs', attr: { role: 'tablist', 'aria-label': 'Sync activity' } });

		const pendingTab = tabs.createEl('button', {
			cls: 'crate-activity-tab crate-activity-tab-active',
			attr: { type: 'button', role: 'tab', 'aria-selected': 'true' },
		});
		pendingTab.createSpan({ text: 'Pending' });
		this.pendingCount = pendingTab.createSpan({ cls: 'crate-tab-count' });

		const conflictsTab = tabs.createEl('button', {
			cls: 'crate-activity-tab',
			attr: { type: 'button', role: 'tab', 'aria-selected': 'false' },
		});
		conflictsTab.createSpan({ text: 'Conflicts' });
		this.conflictsCount = conflictsTab.createSpan({ cls: 'crate-tab-count' });

		const historyTab = tabs.createEl('button', {
			cls: 'crate-activity-tab',
			attr: { type: 'button', role: 'tab', 'aria-selected': 'false' },
		});
		historyTab.createSpan({ text: 'History' });

		this.tabIndicator = tabs.createDiv({ cls: 'crate-activity-tab-indicator' });

		this.updateTabCounts();

		// Panels
		this.pendingPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		this.conflictsPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		this.historyPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		this.conflictsPanel.hide();
		this.historyPanel.hide();

		this.allTabs = [pendingTab, conflictsTab, historyTab];
		this.allPanels = [this.pendingPanel, this.conflictsPanel, this.historyPanel];

		renderPendingPanel(this.pendingPanel, this.deps.getPendingPaths());
		renderConflictsPanel(this.conflictsPanel, this.deps.getActiveConflicts());
		renderHistoryPanel(this.historyPanel, this.settings.syncHistory ?? []);

		for (let i = 0; i < this.allTabs.length; i++) {
			const tab = this.allTabs[i];
			if (!tab) continue;
			tab.tabIndex = i === 0 ? 0 : -1;
			tab.id = `${this.tabIdPrefix}-tab-${i}`;
			const panel = this.allPanels[i];
			if (panel) {
				panel.id = `${this.tabIdPrefix}-panel-${i}`;
				panel.setAttribute('role', 'tabpanel');
				panel.setAttribute('aria-labelledby', tab.id);
				panel.tabIndex = 0;
				tab.setAttribute('aria-controls', panel.id);
			}
			tab.addEventListener('click', () => this.switchTab(i));
			tab.addEventListener('keydown', (event) => {
				let next = i;
				if (event.key === 'ArrowRight') next = (i + 1) % this.allTabs.length;
				else if (event.key === 'ArrowLeft') next = (i + this.allTabs.length - 1) % this.allTabs.length;
				else if (event.key === 'Home') next = 0;
				else if (event.key === 'End') next = this.allTabs.length - 1;
				else return;
				event.preventDefault();
				this.switchTab(next);
				this.allTabs[next]?.focus();
			});
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
				tab.setAttribute('aria-selected', 'true');
				tab.tabIndex = 0;
				panel.show();
			} else {
				tab.removeClass('crate-activity-tab-active');
				tab.setAttribute('aria-selected', 'false');
				tab.tabIndex = -1;
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
		this.syncBtn.setAttribute('aria-label', syncing ? 'Syncing' : 'Sync now');
		this.syncBtn.setAttribute('title', syncing ? 'Syncing' : 'Sync now');
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
		const expanded = new Set(Array.from(this.historyPanel.querySelectorAll('details[open]'))
			.map((entry) => entry.getAttribute('data-history-key')));
		const scrollTop = this.historyPanel.scrollTop;
		this.historyPanel.empty();
		renderHistoryPanel(this.historyPanel, this.settings.syncHistory ?? []);
		this.historyPanel.querySelectorAll('details').forEach((entry) => {
			entry.open = expanded.has(entry.getAttribute('data-history-key'));
		});
		this.historyPanel.scrollTop = scrollTop;
		this.contentEl.win.requestAnimationFrame(() => this.positionIndicator(this.currentTabIndex));
	}

	private formatLastSync(): string {
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
		this.deps.removeStateChangeListener(this.onStateChange);
		this.root?.unmount();
		this.root = undefined;
		this.contentEl.empty();
		this.contentEl.removeClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
	}
}
