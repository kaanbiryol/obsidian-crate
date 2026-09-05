import { AbstractInputSuggest, TFolder, type App } from 'obsidian';

export class RemindersFolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, input: HTMLInputElement) {
		super(app, input);
		this.onSelect(folder => {
			this.setValue(folder.path);
			this.close();
			input.focus();
		});
	}

	getSuggestions(query: string): TFolder[] {
		return this.app.vault.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder && !file.isRoot())
			.filter(folder => folder.path.toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}
}
