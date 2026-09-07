import { Modal, Notice, type App } from 'obsidian';

export class SyncDiagnosticsModal extends Modal {
	private events = new AbortController();
	constructor(app: App, private readonly diagnostics: string) { super(app); }
	onOpen(): void {
		this.events = new AbortController();
		this.setTitle('Export sync diagnostics');
		this.contentEl.createEl('p', { text: 'Review and copy this report for support. It contains sync counts, timestamps and request IDs. Note text, filenames, credentials and raw errors are excluded.' });
		const text = this.contentEl.createEl('textarea', {
			cls: 'crate-sync-diagnostics-export', attr: { readonly: true, rows: '16', 'aria-label': 'Sync diagnostic report', spellcheck: 'false' },
		});
		text.value = this.diagnostics;
		const copy = this.contentEl.createEl('button', { text: 'Copy report', attr: { type: 'button' } });
		copy.addEventListener('click', () => {
			text.focus(); text.select();
			void Promise.resolve().then(() => navigator.clipboard.writeText(this.diagnostics))
				.then(() => { if (!this.events.signal.aborted) new Notice('Diagnostic report copied.'); })
				.catch(() => { if (!this.events.signal.aborted) new Notice('Select and copy the report above.'); });
		}, { signal: this.events.signal });
	}
	onClose(): void { this.events.abort(); this.contentEl.empty(); }
}
