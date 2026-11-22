import { Platform, type App } from 'obsidian';
import type { SyncHistoryEntry } from '../../sync/types';
import { SharedModal } from '../plugin/shared-modal';
import { HistoryBrowser, type HistoryBrowserDeps } from './history-browser';
import { DeletedFilesBrowser, type DeletedFilesRuntime } from './deleted-files-browser';

export type VaultHistoryView = 'syncs' | 'deleted';

/** A native dialog above Sync activity preserves its list, scroll and focus. It compares saved
 * vault states; **Deleted files** in its header opens the files to bring back, and the back
 * button returns to the syncs. */
export class VaultHistoryModal extends SharedModal {
	private browser?: HistoryBrowser;
	private deletedBrowser?: DeletedFilesBrowser;
	private syncsEl!: HTMLElement;
	private deletedEl!: HTMLElement;

	constructor(app: App, private history: SyncHistoryEntry[], private deps: HistoryBrowserDeps, private readonly deleted: DeletedFilesRuntime,
		private onClosed: () => void, private view: VaultHistoryView = 'syncs') { super(app); }

	onOpen(): void {
		this.openLayout('Vault history');
		this.modalEl.addClass('crate-file-history-modal', 'crate-vault-history-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		this.bodyEl.addClass('crate-vault-history-body');
		this.syncsEl = this.bodyEl.createDiv({ cls: 'crate-vault-history-panel' });
		this.deletedEl = this.bodyEl.createDiv({ cls: 'crate-vault-history-panel' });
		this.browser = new HistoryBrowser(this.syncsEl, this.deps);
		this.browser.update(this.history);
		this.show(this.view, false);
	}

	/** Deleted files load the first time they are shown. */
	show(view: VaultHistoryView, focus = true): void {
		this.view = view;
		const deleted = view === 'deleted';
		this.syncsEl.hidden = deleted;
		this.deletedEl.hidden = !deleted;
		if (deleted) {
			this.setLayoutHeader({ title: 'Deleted files', back: { label: 'Back to vault history', run: () => this.show('syncs') } });
			this.deletedBrowser ??= new DeletedFilesBrowser(this.deletedEl, this.app, this.deleted);
			if (focus) this.deletedBrowser.searchEl.focus();
		} else {
			this.setLayoutHeader({ title: 'Vault history', action: { label: 'Deleted files', onClick: () => this.show('deleted') } });
			if (focus) this.contentEl.querySelector<HTMLElement>('.reminder-modal-header-action')?.focus();
		}
	}

	update(history: SyncHistoryEntry[]): void {
		this.history = history;
		this.browser?.update(history);
	}

	onClose(): void {
		this.browser?.dispose();
		this.browser = undefined;
		this.deletedBrowser?.dispose();
		this.deletedBrowser = undefined;
		super.onClose();
		this.onClosed();
	}
}
