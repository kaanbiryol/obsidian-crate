import { setSharedFeature } from '../../plugin/feature-settings';
import { captureServerConnection } from '../../plugin/server-request';
import { Notice, Platform, Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { createSettingsDisclosure } from '../../ui/settings/section-helpers';
import { FolderSuggest } from '../../ui/settings/folder-suggest';
import { bindCommittedText } from '../../ui/settings/input-helpers';
import { readingServerRequest, type ServerReadingPolicy } from '../server';
import { startReading, stopReading, validateReadingConfiguration } from '../runtime';
import { READING_VIEW_TYPE } from './reading-view';

export function renderReadingSettings(container: HTMLElement, plugin: CratePlugin, rerender: () => void): () => void {
	let folderSuggest: FolderSuggest | undefined;
	createSettingsDisclosure(container, 'Reading', { summary: plugin.settings.reading.enabled ? `Folder: ${plugin.settings.reading.folderPath}` : 'Paused', onOpen: options => {
		new Setting(options).setName('Enable reading')
			.setDesc(`All devices · pause or resume reading and article downloads. ${Platform.isDesktopApp ? 'This device downloads saved links directly into your vault.' : 'Your server downloads saved links.'} Saved notes and vault sync are preserved.`)
			.addToggle(toggle => toggle.setValue(plugin.settings.reading.enabled).onChange(async enabled => {
				toggle.setDisabled(true);
				try {
					await setSharedFeature(plugin, 'reading', enabled);
				} catch (error) { new Notice(error instanceof Error ? error.message : 'Could not change Reading.'); }
				finally { rerender(); }
			}));
		if (!plugin.settings.reading.enabled) return;

		new Setting(options).setName('Reading folder')
			.setDesc('Notes in this folder appear in reading. Changing the folder does not move files.')
			.addText(text => {
				folderSuggest = new FolderSuggest(plugin.app, text.inputEl);
				text.setValue(plugin.settings.reading.folderPath).setPlaceholder('Reading');
				bindCommittedText(text, () => plugin.settings.reading.folderPath, async folderPath => {
					try {
						const { assertCurrent } = captureServerConnection(plugin);
						const reading = { enabled: true, folderPath };
						validateReadingConfiguration(plugin, reading);
						if (plugin.settings.workerUrl) {
							const { policy } = await readingServerRequest<{ policy: ServerReadingPolicy | null }>(plugin, '/reading/policy');
							assertCurrent();
							if (policy?.enabled && policy.folder_path !== folderPath) {
								const paused = await readingServerRequest<{ policy: ServerReadingPolicy }>(plugin, '/reading/policy', { enabled: false, folderPath: policy.folder_path, revision: policy.revision });
								assertCurrent();
								policy.revision = paused.policy.revision;
								policy.enabled = 0;
							}
							await readingServerRequest(plugin, '/reading/policy', { enabled: Boolean(policy?.enabled), folderPath, revision: policy?.revision ?? null });
						}
						assertCurrent();
						await plugin.writeSettings({ reading }, assertCurrent);
						assertCurrent();
						stopReading(plugin); plugin.app.workspace.detachLeavesOfType(READING_VIEW_TYPE); startReading(plugin);
						rerender();
					} catch (error) { new Notice(error instanceof Error ? error.message : 'Could not change the Reading folder.'); }
				});
			});
	} });
	return () => folderSuggest?.close();
}
