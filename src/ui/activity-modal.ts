import { Modal, type App } from 'obsidian';
import type { CrateSettings, SyncHistoryEntry, SyncState } from '../types';

export interface ActivityModalDeps {
	getPendingPaths(): string[];
	getConflictFiles(): string[];
	getState(): SyncState;
	sync(): Promise<unknown>;
	addStateChangeListener(listener: (state: SyncState) => void): void;
	removeStateChangeListener(listener: (state: SyncState) => void): void;
}

export class ActivityModal extends Modal {
	private readonly settings: CrateSettings;
	private readonly deps: ActivityModalDeps;
	private pendingTab!: HTMLButtonElement;
	private conflictsTab!: HTMLButtonElement;
	private syncBtn!: HTMLButtonElement;
	private pendingPanel!: HTMLDivElement;
	private conflictsPanel!: HTMLDivElement;
	private allTabs: HTMLButtonElement[] = [];
	private allPanels: HTMLDivElement[] = [];
	private readonly onStateChange = () => this.refresh();

	constructor(app: App, settings: CrateSettings, deps: ActivityModalDeps) {
		super(app);
		this.settings = settings;
		this.deps = deps;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('crate-activity-modal');
		contentEl.createEl('h2', { text: 'Sync activity' });

		const tabBar = contentEl.createDiv({ cls: 'crate-activity-tab-bar' });
		const tabs = tabBar.createDiv({ cls: 'crate-activity-tabs' });
		this.pendingTab = tabs.createEl('button', {
			text: this.pendingTabLabel(),
			cls: 'crate-activity-tab crate-activity-tab-active',
		});
		this.conflictsTab = tabs.createEl('button', {
			text: this.conflictsTabLabel(),
			cls: 'crate-activity-tab',
		});
		const historyTab = tabs.createEl('button', {
			text: 'History',
			cls: 'crate-activity-tab',
		});

		this.syncBtn = tabBar.createEl('button', {
			text: 'Sync now',
			cls: 'crate-sync-now-btn',
		});
		this.syncBtn.addEventListener('click', () => {
			void this.deps.sync();
		});
		this.updateSyncBtn();

		this.pendingPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		this.conflictsPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		const historyPanel = contentEl.createDiv({ cls: 'crate-activity-panel' });
		this.conflictsPanel.hide();
		historyPanel.hide();

		this.allTabs = [this.pendingTab, this.conflictsTab, historyTab];
		this.allPanels = [this.pendingPanel, this.conflictsPanel, historyPanel];

		this.renderPending();
		this.renderConflicts();
		this.renderHistory(historyPanel);

		for (let i = 0; i < this.allTabs.length; i++) {
			const idx = i;
			this.allTabs[idx]!.addEventListener('click', () => this.switchTab(idx));
		}

		this.deps.addStateChangeListener(this.onStateChange);
	}

	private switchTab(index: number): void {
		for (let i = 0; i < this.allTabs.length; i++) {
			if (i === index) {
				this.allTabs[i]!.addClass('crate-activity-tab-active');
				this.allPanels[i]!.show();
			} else {
				this.allTabs[i]!.removeClass('crate-activity-tab-active');
				this.allPanels[i]!.hide();
			}
		}
	}

	private pendingTabLabel(): string {
		return `Pending (${this.deps.getPendingPaths().length})`;
	}

	private conflictsTabLabel(): string {
		return `Conflicts (${this.deps.getConflictFiles().length})`;
	}

	private updateSyncBtn(): void {
		const syncing = this.deps.getState().status === 'syncing';
		this.syncBtn.disabled = syncing;
		this.syncBtn.setText(syncing ? 'Syncing...' : 'Sync now');
	}

	private refresh(): void {
		this.updateSyncBtn();
		this.pendingTab.setText(this.pendingTabLabel());
		this.pendingPanel.empty();
		this.renderPending();
		this.conflictsTab.setText(this.conflictsTabLabel());
		this.conflictsPanel.empty();
		this.renderConflicts();
	}

	private renderPending(): void {
		const paths = this.deps.getPendingPaths();
		if (paths.length === 0) {
			this.pendingPanel.createEl('p', { text: 'No pending changes.', cls: 'crate-activity-empty' });
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
		const groups: Array<{ paths: string[]; cls: string; prefix: string }> = [
			{ paths: uploads, cls: 'crate-file-upload', prefix: '\u2191' },
			{ paths: deletes, cls: 'crate-file-delete', prefix: '\u00d7' },
		];
		for (const group of groups) {
			for (const filePath of group.paths) {
				const row = list.createDiv({ cls: `crate-activity-file ${group.cls}` });
				row.createSpan({ text: group.prefix, cls: 'crate-file-prefix' });
				row.createSpan({ text: filePath });
			}
		}
	}

	private renderConflicts(): void {
		const paths = this.deps.getConflictFiles();
		if (paths.length === 0) {
			this.conflictsPanel.createEl('p', { text: 'No conflicts.', cls: 'crate-activity-empty' });
			return;
		}

		const list = this.conflictsPanel.createDiv({ cls: 'crate-activity-list' });
		for (const filePath of paths) {
			const row = list.createDiv({ cls: 'crate-activity-file crate-file-conflict' });
			row.createSpan({ text: '!', cls: 'crate-file-prefix' });
			row.createSpan({ text: filePath });
		}
	}

	private renderHistory(container: HTMLElement): void {
		const history = this.settings.syncHistory ?? [];

		if (history.length === 0) {
			container.createEl('p', { text: 'No sync activity yet.', cls: 'crate-activity-empty' });
			return;
		}

		const list = container.createDiv({ cls: 'crate-activity-list' });

		for (const entry of history) {
			const hasPaths = hasFilePaths(entry);

			if (hasPaths) {
				const details = list.createEl('details', { cls: 'crate-activity-details' });
				const summary = details.createEl('summary', { cls: 'crate-activity-row' });
				renderRowContent(summary, entry);
				renderFileDetails(details, entry);
			} else {
				const row = list.createDiv({ cls: 'crate-activity-row' });
				renderRowContent(row, entry);
			}
		}
	}

	onClose(): void {
		this.deps.removeStateChangeListener(this.onStateChange);
		this.contentEl.empty();
	}
}

function renderRowContent(el: HTMLElement, entry: SyncHistoryEntry): void {
	el.createSpan({ text: formatTimestamp(entry.timestamp), cls: 'crate-activity-time' });
	el.createSpan({ text: ' - ' });
	el.createSpan({ text: entry.type });
	el.createSpan({ text: ' - ' });
	el.createSpan({
		text: formatSummary(entry),
		cls: entry.success ? undefined : 'crate-activity-error',
	});
}

function hasFilePaths(entry: SyncHistoryEntry): boolean {
	return (entry.uploadedPaths?.length ?? 0) > 0
		|| (entry.downloadedPaths?.length ?? 0) > 0
		|| (entry.deletedPaths?.length ?? 0) > 0;
}

function renderFileDetails(container: HTMLElement, entry: SyncHistoryEntry): void {
	const fileList = container.createDiv({ cls: 'crate-activity-files' });

	const groups: Array<{ paths: string[]; cls: string; prefix: string }> = [
		{ paths: entry.uploadedPaths ?? [], cls: 'crate-file-upload', prefix: '\u2191' },
		{ paths: entry.downloadedPaths ?? [], cls: 'crate-file-download', prefix: '\u2193' },
		{ paths: entry.deletedPaths ?? [], cls: 'crate-file-delete', prefix: '\u00d7' },
	];

	for (const group of groups) {
		for (const filePath of group.paths) {
			const fileName = filePath.split('/').pop() ?? filePath;
			const row = fileList.createDiv({ cls: `crate-activity-file ${group.cls}` });
			row.createSpan({ text: group.prefix, cls: 'crate-file-prefix' });
			row.createSpan({ text: fileName, attr: { title: filePath } });
		}
	}
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
