import { Setting, type TextAreaComponent } from 'obsidian';
import type CratePlugin from '../../main';
import { matchIgnorePattern } from '../../sync/engine-ignore';
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
		.setDesc('One pattern per line. A folder pattern ends in /. Existing server copies are kept. Applies to all devices.')
		.addTextArea(text => {
			input = text;
			text.setValue(plugin.settings.ignorePatterns.join('\n')).setPlaceholder('Archive/\n*.tmp');
			text.inputEl.rows = 6;
			text.inputEl.addEventListener('input', () => preview.empty());
			bindCommittedText(text, () => plugin.settings.ignorePatterns.join('\n'),
				value => save(patternsFromText(value)));
		});

	new Setting(containerEl)
		.setName('Preview exclusions')
		.setDesc('Preview matching files indexed by Obsidian. Hidden files and folders are not included in this preview.')
		.addButton(button => button.setButtonText('Preview files').onClick(() => {
			const patterns = patternsFromText(input.inputEl.value);
			const patternCache = new Map<string, RegExp>();
			const matches = plugin.app.vault.getFiles()
				.filter(file => patterns.some(pattern => matchIgnorePattern(file.path, pattern, patternCache)))
				.map(file => file.path).sort();
			preview.empty();
			preview.createEl('p', { text: `${matches.length} matching files`, cls: 'setting-item-description' });
			if (matches.length) {
				const list = preview.createEl('ul');
				for (const path of matches.slice(0, 100)) list.createEl('li', { text: path });
				if (matches.length > 100) preview.createEl('p', { text: 'Showing the first 100 matches.' });
			}
		}));
	const preview = containerEl.createDiv({ cls: 'crate-exclusions-preview' });
	preview.setAttribute('role', 'status');
}
