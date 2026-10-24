import { createSettingsDisclosure } from '../../plugin/settings-disclosure';
import { createModalActions, createModalFooter } from '../../plugin/shared-modal';
import { Setting, type ButtonComponent } from 'obsidian';
import { errorMessage } from '../../../platform/logger';
import type { EncryptionProgress } from '../../../sync/encryption/server-encryption';
import { renderEncryptionProgress } from './encryption-progress-ui';

export function renderEncryptionLoading(container: HTMLElement): void {
  container.empty(); container.addClass('crate-encryption-setup');
  container.setAttribute('aria-busy', 'true');
  const content = container.createDiv({ cls: 'crate-encryption-setup__content' });
  content.createEl('p', { cls: 'crate-encryption-intro', text: 'Loading encryption settings…', attr: { role: 'status' } });
  const placeholders = content.createDiv({ attr: { 'aria-hidden': 'true' } });
  for (let i = 0; i < 2; i++) placeholders.createDiv({ cls: 'crate-encryption-placeholder' });
  const footer = createModalFooter(container);
  footer.addClass('crate-encryption-footer');
  createModalActions(footer).addButton(button => button.setButtonText('Loading…').setDisabled(true));
}

/** The owner verifies the recovery key before rendering; an interrupted setup resumes from its checkpoint. */
export function renderEncryptionSetup(container: HTMLElement, options: {
  recovery: string;
  assertCurrent(): void;
  /** Asks the user to accept deleting the server copy and its history. */
  confirm(): Promise<boolean>;
  encrypt(code: string, progress: EncryptionProgress): Promise<void>;
  automaticSync(): boolean;
  setTitle(title: string): void;
  manage(): void;
  close(): void;
}): () => void {
  container.addClass('crate-encryption-setup');
  const content = container.createDiv({ cls: 'crate-encryption-setup__content' });
  let busy = false, disposed = false;
  let primary: ButtonComponent | undefined;
  const key = content.createDiv({ cls: 'crate-encryption-key' });
  const field = new Setting(key).setClass('crate-encryption-key__header')
    .setName('Recovery key').setDesc('Save a copy outside your vault.');
  field.nameEl.id = `crate-key-${crypto.randomUUID()}`;
  const output = key.createEl('textarea', { cls: 'crate-text-input crate-encryption-recovery' });
  output.readOnly = true; output.value = options.recovery; output.rows = 2; output.spellcheck = false;
  output.setAttribute('aria-labelledby', field.nameEl.id);
  const warning = content.createEl('p', { cls: 'crate-encryption-feedback', text: 'Crate cannot recover a lost key.' });
  warning.id = `${field.nameEl.id}-warning`;
  output.setAttribute('aria-describedby', warning.id);
  const copyStatus = content.createEl('p', { cls: 'crate-encryption-feedback', attr: { role: 'status' } });
  field.addButton(button => {
    button.buttonEl.setAttribute('aria-live', 'polite');
    button.setButtonText('Copy').onClick(async () => {
      if (busy || disposed) return;
      try { options.assertCurrent(); }
      catch (error) { copyStatus.setText(errorMessage(error)); return; }
      button.setDisabled(true); copyStatus.setText('');
      try {
        await output.ownerDocument.defaultView!.navigator.clipboard.writeText(options.recovery);
        if (!disposed) button.setButtonText('Copied');
      } catch {
        if (!disposed) {
          button.setButtonText('Copy');
          copyStatus.setText('Select and copy the key above. Clipboard access is unavailable.');
        }
      } finally { if (!disposed) button.setDisabled(false); }
    });
  });
  const confirmation = content.createEl('label', { cls: 'crate-encryption-confirm' });
  const saved = confirmation.createEl('input', { attr: { type: 'checkbox' } });
  saved.checked = false;
  confirmation.createSpan({ text: 'I’ve saved it outside my vault.' });
  saved.addEventListener('change', () => {
    if (!busy && !disposed) primary?.setDisabled(!saved.checked);
  });
  const details = createSettingsDisclosure(content, 'What changes with encryption?', { inline: true });
  details.parentElement!.addClass('crate-encryption-details', 'crate-encryption-setup__details');
  const changes = details.createEl('ul');
  for (const text of [
    'This device syncs first. Crate then deletes the server copy, its history and checkpoints, and uploads this device’s vault encrypted. Local vault files stay readable.',
    'Sync and notifications pause while encryption runs. Keep Obsidian open.',
    'Other Obsidian devices reconnect and enter the recovery key. Web apps log out and connect again; logging out discards their drafts and pending edits.',
    'Use your recovery key only in web apps you trust. They handle it during unlock and can read entire notes in their connected Reading and Reminders folders.',
    'File and folder names are encrypted. The server still sees folder structure, which files are notes, file sizes and notification times. Notification titles and text are encrypted.',
    'To show page titles for pasted links, the server fetches each link without storing it.',
    'Existing backup copies are not changed or retroactively encrypted.',
    'Turning encryption off later deletes remote data and history before uploading this device’s files.',
  ]) changes.createEl('li', { text });

  const label = 'Enable encryption';
  const run = async () => {
    if (busy || disposed || !saved.checked) return;
    busy = true;
    let confirmed = false;
    try { confirmed = await options.confirm(); } finally { busy = false; }
    if (confirmed) await encrypt();
  };
  // A retry resumes the confirmed setup.
  const encrypt = async () => {
    if (busy || disposed) return;
    busy = true;
    options.setTitle('Encrypting vault');
    const view = renderEncryptionProgress(container);
    try {
      options.assertCurrent();
      await options.encrypt(options.recovery, (message, files) => { if (!disposed) view.update(message, files); });
      if (!disposed) {
        options.setTitle('Encryption enabled');
        view.complete(options.automaticSync(), () => options.manage(), () => options.close());
      }
    } catch (error) {
      if (!disposed) {
        options.setTitle('Encryption needs attention');
        view.fail(errorMessage(error), () => { void encrypt(); });
      }
    } finally { busy = false; }
  };
  const footer = createModalFooter(container);
  footer.addClass('crate-encryption-footer');
  createModalActions(footer).setName(label)
    .addButton(button => {
      primary = button;
      button.setButtonText(label).setCta().setDisabled(true).onClick(run);
    });
  return () => { disposed = true; };
}
