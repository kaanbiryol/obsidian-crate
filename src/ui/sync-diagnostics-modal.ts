import { Notice, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import { createModalActions, createModalFooter } from './shared/modal-elements';

export class SyncDiagnosticsModal extends SharedModal {
	private events = new AbortController();
	constructor(app: App, private readonly diagnostics: string) { super(app); }
	onOpen(): void {
		this.events = new AbortController();
		this.modalEl.addClass('crate-sync-diagnostics-modal');
		this.openLayout('Export sync diagnostics');
		this.bodyEl.createEl('p', { text: 'Review and copy this report for support. It contains sync counts, timestamps and request IDs. Note text, filenames, credentials and raw errors are excluded.' });
		const text = this.bodyEl.createEl('textarea', {
			cls: 'crate-text-input crate-sync-diagnostics-export', attr: { readonly: true, rows: '16', 'aria-label': 'Sync diagnostic report', spellcheck: 'false' },
		});
		text.value = this.diagnostics;
		createModalActions(createModalFooter(this.contentEl)).addButton(button => button.setButtonText('Copy report').onClick(() => {
			text.focus(); text.select();
			void Promise.resolve().then(() => text.ownerDocument.defaultView!.navigator.clipboard.writeText(this.diagnostics))
				.then(() => { if (!this.events.signal.aborted) new Notice('Diagnostic report copied.'); })
				.catch(() => { if (!this.events.signal.aborted) new Notice('Select and copy the report above.'); });
		}));
	}
	onClose(): void { this.events.abort(); super.onClose(); }
}
