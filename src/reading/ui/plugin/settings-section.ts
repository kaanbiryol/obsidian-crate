import { confirmFeatureFolder, setSharedFeature } from '../../../plugin/feature-settings';
import { Notice, Setting } from 'obsidian';
import { createSettingsDisclosure } from '../../../ui/plugin/settings-disclosure';
import { FolderSuggest } from '../../../ui/settings/folder-suggest';
import { bindCommittedText } from '../../../ui/settings/input-helpers';
import type { SettingsSectionContext } from '../../../ui/settings/section-helpers';
import { changeReadingFolder } from '../../runtime';

export function renderReadingSettings({ containerEl: container, plugin, rerender }: SettingsSectionContext): () => void {
	let folderSuggest: FolderSuggest | undefined;
	const reading = plugin.settings.reading;
	createSettingsDisclosure(container, 'Reading', { summary: reading.enabled ? `Folder: ${reading.folderPath}` : reading.confirmed ? 'Paused' : 'Off', onOpen: options => {
		new Setting(options).setName('Enable reading')
			.setDesc(`All devices · pause or resume reading and article downloads. This device downloads saved links directly into your vault. YouTube links also request available transcripts. Playback connects to YouTube only when you select play. Saved notes and vault sync are preserved.${plugin.settings.workerUrl ? '' : ' Connect a server to save and read articles from your phone.'}`)
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
					await changeReadingFolder(plugin, folderPath);
					rerender();
				}, undefined, error => error instanceof Error ? error.message : 'Could not change the Reading folder.');
			});
	} });
	return () => folderSuggest?.close();
}
