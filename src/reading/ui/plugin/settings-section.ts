import { confirmFeatureFolder, setSharedFeature } from '../../../plugin/feature-settings';
import { captureServerConnection } from '../../../plugin/server-request';
import { Notice, Setting } from 'obsidian';
import { createSettingsDisclosure } from '../../../ui/plugin/settings-disclosure';
import { FolderSuggest } from '../../../ui/settings/folder-suggest';
import { bindCommittedText } from '../../../ui/settings/input-helpers';
import type { SettingsSectionContext } from '../../../ui/settings/section-helpers';
import { readReadingPolicy, writeReadingPolicy } from '../../server';
import { restartReading, validateReadingConfiguration } from '../../runtime';

export function renderReadingSettings({ containerEl: container, plugin, rerender }: SettingsSectionContext): () => void {
	let folderSuggest: FolderSuggest | undefined;
	const reading = plugin.settings.reading;
	createSettingsDisclosure(container, 'Reading', { summary: reading.enabled ? `Folder: ${reading.folderPath}` : reading.confirmed ? 'Paused' : 'Off', onOpen: options => {
		new Setting(options).setName('Enable reading')
			.setDesc('All devices · pause or resume reading and article downloads. This device downloads saved links directly into your vault. YouTube links also request available transcripts. Playback connects to YouTube only when you select play. Saved notes and vault sync are preserved.')
			.addToggle(toggle => toggle.setValue(plugin.settings.reading.enabled).onChange(async enabled => {
				toggle.setDisabled(true);
				try {
					if (!enabled || await confirmFeatureFolder(plugin, 'reading')) await setSharedFeature(plugin, 'reading', enabled);
				} catch (error) { new Notice(error instanceof Error ? error.message : 'Could not change Reading.'); }
				finally { rerender(); }
			}));

		new Setting(options).setName('Reading folder')
			.setDesc('Notes in this folder appear in reading. Changing the folder does not move files.')
			.addText(text => {
				folderSuggest = new FolderSuggest(plugin.app, text.inputEl);
				text.setValue(plugin.settings.reading.folderPath).setPlaceholder('Reading');
				bindCommittedText(text, () => plugin.settings.reading.folderPath, async folderPath => {
					try {
						const { assertCurrent } = captureServerConnection(plugin);
						validateReadingConfiguration(plugin, { ...plugin.settings.reading, folderPath });
						if (plugin.settings.workerUrl) {
							const policy = await readReadingPolicy(plugin);
							assertCurrent();
							if (policy?.enabled && policy.folder_path !== folderPath) {
								const paused = await writeReadingPolicy(plugin, { enabled: false, folderPath: policy.folder_path, revision: policy.revision });
								assertCurrent();
								policy.revision = paused.revision;
								policy.enabled = 0;
							}
							await writeReadingPolicy(plugin, { enabled: Boolean(policy?.enabled), folderPath, revision: policy?.revision ?? null });
						}
						assertCurrent();
						// Read after the requests, so a pause made meanwhile stays in place.
						await plugin.writeSettings({ reading: { ...plugin.settings.reading, folderPath } }, assertCurrent);
						assertCurrent();
						restartReading(plugin);
						rerender();
					} catch (error) { new Notice(error instanceof Error ? error.message : 'Could not change the Reading folder.'); }
				});
			});
	} });
	return () => folderSuggest?.close();
}
