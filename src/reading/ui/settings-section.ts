import { readingServerRequest, type ServerReadingPolicy } from '../server';
import { ReadingPhoneSetup } from './phone-setup';
import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { createSettingsSectionHeading } from '../../ui/settings/section-helpers';
import { bindCommittedText } from '../../ui/settings/input-helpers';
import { createReadingClipperTemplate } from '../clipper-template';
import { openReading } from '../register-integrations';
import { startReading, stopReading, validateReadingConfiguration } from '../runtime';
import type { ReadingSettings } from '../settings';
import { READING_VIEW_TYPE } from './reading-view';

export function renderReadingSettings(container: HTMLElement, plugin: CratePlugin, rerender: () => void): void {
	createSettingsSectionHeading(container, 'Reading');
	const settings = plugin.settings.reading;
	const save = async (reading: ReadingSettings) => {

    validateReadingConfiguration(plugin, reading);
    if (plugin.settings.workerUrl && reading.folderPath !== plugin.settings.reading.folderPath) {
      const current = await readingServerRequest<{ policy: ServerReadingPolicy | null }>(plugin, '/reading/policy');
      if (current.policy && current.policy.folder_path !== reading.folderPath) await readingServerRequest(plugin, '/reading/policy', { enabled: false, folderPath: reading.folderPath, revision: current.policy.revision });
    }
		if (reading.enabled) validateReadingConfiguration(plugin, reading);
		await plugin.writeSettings({ reading });
		stopReading(plugin);
		plugin.app.workspace.detachLeavesOfType(READING_VIEW_TYPE);
		startReading(plugin);
		rerender();
	};
	new Setting(container).setName('Enable reading on this device')
		.setDesc('Keep saved links and web clips in your vault. Reading notes sync with your other files. Turning this off keeps your notes.')
		.addToggle(toggle => toggle.setValue(settings.enabled).onChange(async enabled => {
			toggle.setDisabled(true);
			try { await save({ ...plugin.settings.reading, enabled }); }
			catch (error) { new Notice(error instanceof Error ? error.message : 'Could not update reading settings.'); rerender(); }
		}));
	new Setting(container).setName('Reading folder').setDesc('A separate folder for marked reading notes. Changing it does not move files.')
		.addText(text => {
			text.setValue(settings.folderPath).setPlaceholder('Reading');
			bindCommittedText(text, () => plugin.settings.reading.folderPath, folderPath => save({ ...plugin.settings.reading, folderPath }));
		});

  if (plugin.settings.workerUrl) {
    let serverPolicy: ServerReadingPolicy | null = null;
    const connected = new Setting(container).setName('Web reading and phone saves').setDesc('Loading server reading settings…');
    const loaded = readingServerRequest<{ policy: ServerReadingPolicy | null }>(plugin, '/reading/policy').then(result => {
      serverPolicy = result.policy;
      if (container.isConnected) connected.setDesc(serverPolicy?.enabled ? `Enabled · ${serverPolicy.folder_path}. Your server fetches saved URLs to extract text. Articles stay in your server and vault.` : 'Enable server capture to save links while Obsidian is closed. Your server requests the saved website without your browser login.');
    });
    void loaded.catch((error: unknown) => { if (container.isConnected) connected.setDesc(error instanceof Error ? error.message : 'Server settings are unavailable.'); });
    connected.addButton(button => button.setButtonText('Enable server reading').onClick(async () => {
      button.setDisabled(true);
      try { await loaded; validateReadingConfiguration(plugin, plugin.settings.reading);
        const result = await readingServerRequest<{ policy: ServerReadingPolicy }>(plugin, '/reading/policy', { enabled: true, folderPath: serverPolicy?.folder_path ?? plugin.settings.reading.folderPath, revision: serverPolicy?.revision ?? null });
        await save({ enabled: true, folderPath: result.policy.folder_path });
      } catch (error) { new Notice(error instanceof Error ? error.message : 'Could not enable server Reading.'); button.setDisabled(false); }
    })).addButton(button => button.setButtonText('Disable server reading').onClick(async () => {
      try { await loaded; if (!serverPolicy) return; await readingServerRequest(plugin, '/reading/policy', { enabled: false, folderPath: serverPolicy.folder_path, revision: serverPolicy.revision }); rerender(); }
      catch (error) { new Notice(error instanceof Error ? error.message : 'Could not disable server Reading.'); }
    }));
    new Setting(container).setName('Reading on the web').setDesc('An enrolled reminders web app opens reading automatically. Use a setup link for a new browser.')
      .addButton(button => button.setButtonText('Open web reading').onClick(async () => {
        try { const result = await readingServerRequest<{ url: string }>(plugin, '/reading/access', { kind: 'reading' }); window.open(result.url, '_blank', 'noopener,noreferrer'); }
        catch (error) { new Notice(error instanceof Error ? error.message : 'Could not open Reading.'); }
      })).addButton(button => button.setButtonText('Copy setup link').onClick(async () => {
        try { const result = await readingServerRequest<{ url: string }>(plugin, '/reading/access', { kind: 'reading' }); await navigator.clipboard.writeText(result.url); new Notice('Reading setup link copied. It expires in 10 minutes.'); }
        catch (error) { new Notice(error instanceof Error ? error.message : 'Could not copy setup link.'); }
      }));
    new Setting(container).setName('Save from iPhone').setDesc('Set up a share sheet shortcut with the branded Crate confirmation screen.')
      .addButton(button => button.setButtonText('Set up shortcut').onClick(() => new ReadingPhoneSetup(plugin).open()));
  }
	if (!settings.enabled) return;
	new Setting(container).setName('Reading library').setDesc('Browse your inbox, favorites, and archive.')
		.addButton(button => button.setButtonText('Open reading').onClick(() => { void openReading(plugin); }));
	new Setting(container).setName('Web clipper template')
		.setDesc('Copy the template, then import it from the clipboard in Obsidian web clipper settings. Select the imported template when saving an article.')
		.addButton(button => button.setButtonText('Copy template').onClick(async () => {
			try { await navigator.clipboard.writeText(createReadingClipperTemplate(settings.folderPath)); new Notice('Reading template copied.'); }
			catch { new Notice('Could not copy the template. Check clipboard access and try again.'); }
		}));
}
