import { Setting, type TextComponent } from 'obsidian';
import { verifyRecoveryCode } from '../../../encryption/recovery-verification';
import type { RecoveryEnvelope, VaultKeyBundle } from '../../../encryption/key-bundle';

/** Checks a pasted recovery key against the server's recovery envelope; returns a disposer. */
export function renderRecoveryVerification(container: HTMLElement, envelope: RecoveryEnvelope, bundle: VaultKeyBundle,
	assertCurrent: () => void): () => void {
	let revision = 0, disposed = false;
	let input: TextComponent;
	const field = new Setting(container).setClass('crate-recovery-verification').setName('Saved recovery key').setDesc('Paste the copy you saved outside this vault.');
	const labelId = `crate-recovery-${crypto.randomUUID()}`;
	field.nameEl.id = labelId;
	const status = container.createEl('p', { cls: 'crate-encryption-feedback', attr: { role: 'status', 'aria-live': 'polite', id: `${labelId}-status` } });
	const invalidate = () => {
		revision++; status.setText('');
		status.toggleClass('is-verified', false);
		input.inputEl.setAttribute('aria-invalid', 'false');
	};
	const check = async (candidate: string) => {
		const started = revision;
		status.setText('Checking key…');
		try {
			await verifyRecoveryCode(envelope, candidate, bundle);
			if (disposed || started !== revision) return;
			assertCurrent();
			status.setText('Key verified'); status.toggleClass('is-verified', true);
		} catch {
			if (disposed || started !== revision) return;
			input.inputEl.setAttribute('aria-invalid', 'true');
			status.setText('Could not verify this key. Check your saved copy and connection.');
		}
	};
	field.addText(text => {
		input = text;
		text.inputEl.type = 'password'; text.inputEl.autocomplete = 'off'; text.inputEl.spellcheck = false;
		text.inputEl.className = 'crate-text-input';
		text.inputEl.setAttribute('autocapitalize', 'none');
		text.inputEl.setAttribute('aria-labelledby', labelId);
		text.inputEl.setAttribute('aria-describedby', `${labelId}-status`);
		text.setPlaceholder('Paste saved key').onChange(value => {
			if (disposed) return;
			const code = value.trim(); invalidate();
			if (code) void check(code);
		});
	});
	return () => { disposed = true; revision++; };
}
