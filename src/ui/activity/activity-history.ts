import type { SyncHistoryEntry } from '../../sync/types';
import type { App } from 'obsidian';
import { VaultHistoryModal } from './vault-history-modal';
import type { HistoryBrowserDeps } from './history-browser';
import { renderHistoryPanel } from './history-timeline';

/** Keep routine activity compact; load saved contents only in the recovery screen. */
export class ActivityHistory {
    private history: SyncHistoryEntry[] = [];
    private signature = '';
    private modal?: VaultHistoryModal;
    private active = true;
    private readonly browse: HTMLButtonElement;
    private readonly toolbar: HTMLElement;
    private readonly timeline: HTMLElement;

    constructor(private app: App, private panel: HTMLElement, private deps: HistoryBrowserDeps) {
        panel.addClass('crate-history-timeline');
        this.toolbar = panel.createDiv({ cls: 'crate-history-timeline-toolbar' });
        this.browse = this.toolbar.createEl('button', { text: 'Browse vault history', cls: 'crate-activity-action', attr: { type: 'button' } });
        this.browse.addEventListener('click', () => this.show());
        this.timeline = panel.createDiv({ cls: 'crate-history-timeline-content' });
    }

    update(history: SyncHistoryEntry[]): void {
        this.history = history;
        const signature = JSON.stringify(history);
        if (this.signature !== signature) {
            this.signature = signature;
            const scrollTop = this.panel.scrollTop;
            const expanded = new Set(Array.from(this.timeline.querySelectorAll('details[open]')).map(row => row.getAttribute('data-history-key')));
            const focused = this.panel.ownerDocument.activeElement as HTMLElement | null;
            const focusedKey = this.timeline.contains(focused) ? focused?.closest('details')?.getAttribute('data-history-key') : undefined;
            const focusedAction = focused?.getAttribute('aria-label');
            this.timeline.empty();
            renderHistoryPanel(this.timeline, history, this.deps.openFile?.bind(this.deps));
            this.toolbar.querySelector('h3')?.remove();
            const firstDate = this.timeline.querySelector<HTMLElement>('.crate-history-day-label');
            if (firstDate) this.toolbar.prepend(firstDate);
            for (const row of Array.from(this.timeline.querySelectorAll('details'))) {
                row.open = expanded.has(row.getAttribute('data-history-key'));
                if (focusedKey && row.getAttribute('data-history-key') === focusedKey) {
                    const target = focusedAction ? Array.from(row.querySelectorAll<HTMLButtonElement>('button')).find(button => button.getAttribute('aria-label') === focusedAction) : row.querySelector('summary');
                    target?.focus({ preventScroll: true });
                }
            }
            this.panel.scrollTop = scrollTop;
        }
        this.modal?.update(history);
    }

    private show(): void {
        if (this.modal) return;
        this.modal = new VaultHistoryModal(this.app, this.history, this.deps, () => {
            this.modal = undefined;
            if (this.active && this.browse.isConnected) this.browse.focus({ preventScroll: true });
        });
        this.modal.open();
    }

    dispose(): void {
        this.active = false;
        this.modal?.close();
    }
}
