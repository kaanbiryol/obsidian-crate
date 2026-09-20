import { Platform, type App } from 'obsidian';
import type { SyncHistoryEntry } from '../../sync/types';
import { SharedModal } from '../shared/SharedModal';
import { HistoryBrowser, type HistoryBrowserDeps } from './history-browser';

/** A native dialog above Sync activity preserves its list, scroll and focus. */
export class VaultHistoryModal extends SharedModal {
    private browser?: HistoryBrowser;

    constructor(app: App, private history: SyncHistoryEntry[], private deps: HistoryBrowserDeps,
        private onClosed: () => void) { super(app); }

    onOpen(): void {
        this.openLayout('Vault history');
        this.modalEl.addClass('crate-file-history-modal', 'crate-vault-history-modal');
        this.modalEl.toggleClass('is-mobile', Platform.isMobile);
        this.browser = new HistoryBrowser(this.bodyEl, this.deps);
        this.browser.update(this.history);
    }

    update(history: SyncHistoryEntry[]): void {
        this.history = history;
        this.browser?.update(history);
    }

    onClose(): void {
        this.browser?.dispose();
        this.browser = undefined;
        super.onClose();
        this.onClosed();
    }
}
