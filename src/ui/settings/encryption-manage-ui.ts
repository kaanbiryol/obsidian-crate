import { createSettingsDisclosure } from '../plugin/settings-disclosure';
import { Setting } from 'obsidian';
import { errorMessage } from '../../plugin/logger';

export function renderEncryptionManagement(container: HTMLElement, options: {
  copyRecovery(): Promise<void>;
  connectApp(): void;
  turnOff(): void;
  advanced(container: HTMLElement): () => void;
}): () => void {
  container.addClass('crate-encryption-manage');
  let disposed = false;
  const status = container.createDiv({ cls: 'crate-encryption-manage__status' });
  status.createEl('strong', { text: 'Encryption on' });
  status.createSpan({ text: 'Unlocked on this device' });
  const feedback = container.createEl('p', { cls: 'crate-encryption-feedback', attr: { role: 'status', 'aria-live': 'polite' } });
  const copyRow = (name: string, description: string, copy: () => Promise<void>) => {
    new Setting(container).setName(name).setDesc(description).addButton(button => {
      button.setButtonText('Copy').onClick(async () => {
        button.setDisabled(true); feedback.setText('');
        try { await copy(); if (!disposed) button.setButtonText('Copied'); }
        catch (error) { if (!disposed) feedback.setText(errorMessage(error)); }
        finally { if (!disposed) button.setDisabled(false); }
      });
    });
  };
  new Setting(container).setName('Connect web app').setDesc('Connect without copying keys.')
    .addButton(button => button.setButtonText('Connect').onClick(() => options.connectApp()));
  copyRow('Recovery key', 'Keep a copy for recovery.', () => options.copyRecovery());
  const advanced = createSettingsDisclosure(container, 'Advanced', { inline: true });
  advanced.parentElement!.addClass('crate-encryption-manage__advanced');
  const disposeAdvanced = options.advanced(advanced);
  new Setting(container).setName('Turn off encryption').setDesc('Resets synced data and history.')
    .addButton(button => button.setButtonText('Turn off').setDestructive().onClick(() => options.turnOff()));
  return () => { disposed = true; disposeAdvanced(); };
}
