import { Notice, Setting, type TextAreaComponent } from 'obsidian';
import { matchIgnorePattern } from '../../sync/engine-ignore';
import { getAllVaultFiles } from '../../sync/file-discovery';
import type CratePlugin from '../../main';
import { ExclusionPreviewModal } from '../exclusion-preview-modal';
import { renderExclusionCleanup } from './exclusion-cleanup';
import { bindCommittedText } from './input-helpers';

export function renderExclusionsSetting(
	containerEl: HTMLElement,
	plugin: CratePlugin,
	save: (patterns: string[]) => Promise<void>,
): void {
	let input: TextAreaComponent;
	const patternsFromText = (value: string) => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
	new Setting(containerEl)
		.setName('Excluded files and folders')
		.setDesc('All devices · one pattern per line. A folder pattern ends in /. Existing server copies are kept.')
		.addTextArea(text => {
			input = text;
			text.setValue(plugin.settings.ignorePatterns.join('\n')).setPlaceholder('Archive/\n*.tmp');
			text.inputEl.rows = 6;
			bindCommittedText(text, () => plugin.settings.ignorePatterns.join('\n'),
				value => save(patternsFromText(value)));
		});

	new Setting(containerEl)
		.setName('Preview exclusions')
		.setDesc('Preview matching vault files, including hidden files and folders.')
		.addButton(button => button.setButtonText('Preview files').onClick(async () => {
			button.setDisabled(true);
			try {
				const draft = input.inputEl.value;
				const patterns = patternsFromText(draft);
				const patternCache = new Map<string, RegExp>();
				const matches = (await getAllVaultFiles(plugin.app.vault, () => false))
					.filter(file => patterns.some(pattern => matchIgnorePattern(file.path, pattern, patternCache)))
					.map(file => file.path).sort();
				if (input.inputEl.value !== draft) return;
				new ExclusionPreviewModal(plugin.app, matches).open();
			} catch {
				new Notice('Could not preview exclusions. Try again.');
			} finally { button.setDisabled(false); }
		}));
	renderExclusionCleanup(containerEl, plugin);
}
