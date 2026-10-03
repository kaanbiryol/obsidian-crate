import { Setting } from 'obsidian';
import type { EncryptionProgress } from '../../sync/encryption-conversion';

/** A dedicated conversion view keeps recovery controls out of the running operation. */
export function renderEncryptionProgress(container: HTMLElement) {
  container.empty();
  // The view is ready immediately; keeping its live region busy would hide stage updates.
  container.setAttribute('aria-busy', 'false');
  const content = container.createDiv({ cls: 'crate-encryption-setup__content crate-encryption-operation' });
  const status = content.createEl('p', { cls: 'crate-encryption-operation__title', text: 'Preparing encrypted storage', attr: { role: 'status', 'aria-live': 'polite' } });
  const count = content.createEl('p', { cls: 'crate-encryption-intro' });
  const bar = content.createEl('progress', { cls: 'crate-encryption-progress', attr: { 'aria-label': 'Encryption progress' } });
  const explanation = content.createEl('p', { cls: 'crate-encryption-intro', text: 'Keep Obsidian open. Sync and notifications pause while existing server content is encrypted. Your local files stay readable.' });
  const footer = container.createDiv({ cls: 'crate-encryption-footer' });
  new Setting(footer).addButton(button => button.setButtonText('Encrypting…').setDisabled(true));
  const update: EncryptionProgress = (message, files) => {
    status.setText(message);
    count.setText(files ? files.total === undefined ? `${files.completed} files and versions encrypted` : `${files.completed} of ${files.total} files and versions` : '');
    if (files?.total && files.completed <= files.total) {
      bar.setAttribute('max', String(files.total));
      bar.setAttribute('value', String(files.completed));
      bar.setAttribute('aria-label', 'Files and versions encrypted');
    } else {
      bar.removeAttribute('value');
      bar.removeAttribute('max');
      bar.setAttribute('aria-label', 'Encryption progress');
    }
  };
  const finish = (title: string, detail: string) => {
    container.setAttribute('aria-busy', 'false');
    status.setText(title); count.setText(''); bar.remove();
    explanation.setText(detail); footer.empty();
  };
  return {
    update,
    fail(message: string, retry: () => void) {
      finish('Encryption needs attention', `${message} Keep your saved recovery key. Retry to continue safely.`);
      new Setting(footer).addButton(button => button.setButtonText('Retry').setCta().onClick(retry));
    },
    complete(automaticSync: boolean, manage: () => void, close: () => void) {
      finish('Your vault is protected', 'Server content is encrypted. Files you sync from now on are encrypted on this device before uploading.');
      content.createEl('p', { cls: 'crate-encryption-intro', text: automaticSync
        ? 'Automatic sync remains on. Pending local changes will upload encrypted on the next sync.'
        : 'Automatic sync remains off. Select Sync now when you’re ready to upload local changes.' });
      const next = content.createEl('p', { cls: 'crate-encryption-intro', text: 'Approve your web apps from ' });
      next.createEl('strong', { text: 'Manage encryption' });
      next.createSpan({ text: ' → ' });
      next.createEl('strong', { text: 'Connect web app' });
      next.createSpan({ text: '. No reinstall is needed.' });
      new Setting(footer)
        .addButton(button => button.setButtonText('Manage encryption').onClick(manage))
        .addButton(button => button.setButtonText('Done').setCta().onClick(close));
    },
  };
}
