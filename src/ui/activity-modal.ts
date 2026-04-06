import { Modal, setIcon, type App } from 'obsidian';
import type { CrateSettings, SyncHistoryEntry, SyncState } from '../plugin/types';

export interface ActivityModalDeps {
	getPendingPaths(): string[];
	getConflictFiles(): string[];
	getState(): SyncState;
	sync(): Promise<unknown>;
	addStateChangeListener(listener: (state: SyncState) => void): void;
	removeStateChangeListener(listener: (state: SyncState) => void): void;
}

type FileCardType = 'upload' | 'download' | 'delete' | 'conflict';

const FILE_CARD_ICONS: Record<FileCardType, string> = {
	upload: 'upload',
	download: 'download',
	delete: 'trash-2',
	conflict: 'alert-triangle',
};

export class ActivityModal extends Modal {
	private readonly settings: CrateSettings;
	private readonly deps: ActivityModalDeps;
	private tabIndicator!: HTMLDivElement;
	private subtitleEl!: HTMLSpanElement;
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

		this.renderPending();
		this.renderConflicts();
		this.renderHistory(historyPanel);

		for (let i = 0; i < this.allTabs.length; i++) {
			const tab = this.allTabs[i];
			if (!tab) continue;
			tab.addEventListener('click', () => this.switchTab(i));
		}

		this.deps.addStateChangeListener(this.onStateChange);

		// Position indicator after layout
		requestAnimationFrame(() => this.positionIndicator(0));
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
		const conflictLen = this.deps.getConflictFiles().length;

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

	private refresh(): void {
		this.updateSyncBtn();
		this.subtitleEl.setText(this.formatLastSync());
		this.updateTabCounts();
		this.pendingPanel.empty();
		this.renderPending();
		this.conflictsPanel.empty();
		this.renderConflicts();
		requestAnimationFrame(() => this.positionIndicator(this.currentTabIndex));
	}

	private renderPending(): void {
		const paths = this.deps.getPendingPaths();
		if (paths.length === 0) {
			renderEmptyState(this.pendingPanel, 'check-circle', 'All synced', 'Your vault is up to date.');
			return;
		}

		const uploads: string[] = [];
		const deletes: string[] = [];
		for (const raw of paths) {
			if (raw.startsWith('delete:')) {
				deletes.push(raw.substring(7));
			} else {
				uploads.push(raw);
			}
		}

		const list = this.pendingPanel.createDiv({ cls: 'crate-activity-list' });
		for (const filePath of uploads) renderFileMicroCard(list, filePath, 'upload');
		for (const filePath of deletes) renderFileMicroCard(list, filePath, 'delete');
	}

	private renderConflicts(): void {
		const paths = this.deps.getConflictFiles();
		if (paths.length === 0) {
			renderEmptyState(this.conflictsPanel, 'shield-check', 'No conflicts', 'Everything looks good.');
			return;
		}

		const list = this.conflictsPanel.createDiv({ cls: 'crate-activity-list' });
		for (const filePath of paths) renderFileMicroCard(list, filePath, 'conflict');
	}

	private renderHistory(container: HTMLElement): void {
		const history = this.settings.syncHistory ?? [];

		if (history.length === 0) {
			renderEmptyState(container, 'clock', 'No activity yet', 'Sync history will appear here.');
			return;
		}

		const timeline = container.createDiv({ cls: 'crate-activity-timeline' });

		for (const entry of history) {
			const entryEl = timeline.createDiv({ cls: 'crate-history-entry' });

			// Timeline dot
			const dot = entryEl.createDiv({ cls: 'crate-history-dot' });
			if (!entry.success) dot.addClass('is-error');

			const hasPaths = hasFilePaths(entry);

			if (hasPaths) {
				const details = entryEl.createEl('details', { cls: 'crate-history-details' });
				const summary = details.createEl('summary', { cls: 'crate-history-card' });
				renderHistoryHeader(summary, entry, true);
				renderHistoryFiles(details, entry);
			} else {
				const card = entryEl.createDiv({ cls: 'crate-history-card' });
				renderHistoryHeader(card, entry, false);
			}
		}
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

function renderFileMicroCard(container: HTMLElement, filePath: string, type: FileCardType): void {
	const card = container.createDiv({
		cls: `crate-activity-file-card${type === 'conflict' ? ' crate-file-card-conflict' : ''}`,
	});

	card.createDiv({ cls: `crate-file-accent crate-file-accent-${type}` });

	const iconEl = card.createDiv({ cls: 'crate-file-icon' });
	setIcon(iconEl, FILE_CARD_ICONS[type]);

	const info = card.createDiv({ cls: 'crate-file-info' });
	const parts = filePath.split('/');
	const fileName = parts.pop() ?? filePath;
	const dirPath = parts.join('/');

	info.createSpan({ text: fileName, cls: 'crate-file-name', attr: { title: filePath } });
	if (dirPath) {
		info.createSpan({ text: dirPath, cls: 'crate-file-path' });
	}
}

function renderEmptyState(container: HTMLElement, icon: string, title: string, desc: string): void {
	const wrapper = container.createDiv({ cls: 'crate-activity-empty-state' });
	const iconEl = wrapper.createDiv({ cls: 'crate-empty-icon' });
	setIcon(iconEl, icon);
	const textEl = wrapper.createDiv({ cls: 'crate-empty-text' });
	textEl.createSpan({ text: title, cls: 'crate-empty-title' });
	textEl.createSpan({ text: desc, cls: 'crate-empty-desc' });
}

function renderHistoryHeader(el: HTMLElement, entry: SyncHistoryEntry, expandable: boolean): void {
	const header = el.createDiv({ cls: 'crate-history-header' });
	const meta = header.createDiv({ cls: 'crate-history-meta' });

	meta.createSpan({ text: entry.type, cls: 'crate-history-type' });
	meta.createSpan({ text: formatTimestamp(entry.timestamp), cls: 'crate-history-time' });

	const summaryText = formatSummary(entry);
	header.createSpan({
		text: summaryText,
		cls: `crate-history-summary${entry.success ? '' : ' crate-history-summary-error'}`,
	});

	if (expandable) {
		const chevron = header.createDiv({ cls: 'crate-history-chevron' });
		setIcon(chevron, 'chevron-right');
	}
}

function renderHistoryFiles(container: HTMLElement, entry: SyncHistoryEntry): void {
	const filesEl = container.createDiv({ cls: 'crate-history-files' });

	const groups: Array<{ paths: string[]; type: FileCardType }> = [
		{ paths: entry.uploadedPaths ?? [], type: 'upload' },
		{ paths: entry.downloadedPaths ?? [], type: 'download' },
		{ paths: entry.deletedPaths ?? [], type: 'delete' },
	];

	for (const group of groups) {
		for (const filePath of group.paths) {
			renderFileMicroCard(filesEl, filePath, group.type);
		}
	}
}

function hasFilePaths(entry: SyncHistoryEntry): boolean {
	return (entry.uploadedPaths?.length ?? 0) > 0
		|| (entry.downloadedPaths?.length ?? 0) > 0
		|| (entry.deletedPaths?.length ?? 0) > 0;
}

function formatTimestamp(iso: string): string {
	const d = new Date(iso);
	const month = d.toLocaleString(undefined, { month: 'short' });
	const day = d.getDate();
	const hours = String(d.getHours()).padStart(2, '0');
	const minutes = String(d.getMinutes()).padStart(2, '0');
	return `${month} ${day}, ${hours}:${minutes}`;
}

function formatSummary(entry: SyncHistoryEntry): string {
	if (!entry.success) {
		const parts = [`failed (${entry.errorCount} error${entry.errorCount !== 1 ? 's' : ''})`];
		if (entry.conflictCount > 0) {
			parts.push(`${entry.conflictCount} conflict${entry.conflictCount !== 1 ? 's' : ''}`);
		}
		return parts.join(', ');
	}

	if (entry.uploaded === 0 && entry.downloaded === 0 && entry.deleted === 0 && entry.conflictCount === 0) {
		return 'no changes';
	}

	const parts: string[] = [];
	if (entry.uploaded > 0) parts.push(`${entry.uploaded} up`);
	if (entry.downloaded > 0) parts.push(`${entry.downloaded} down`);
	if (entry.deleted > 0) parts.push(`${entry.deleted} del`);
	if (entry.conflictCount > 0) parts.push(`${entry.conflictCount} conflict${entry.conflictCount !== 1 ? 's' : ''}`);
	return parts.join(', ');
}
