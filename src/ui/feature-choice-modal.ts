import { createModalActions, createModalFooter, SharedModal } from './plugin/shared-modal';
import { Setting, type App } from 'obsidian';
import type { SharedFeatures } from '../protocol/feature-policy';

type Feature = keyof SharedFeatures;

export interface FeatureChoice {
	feature: Feature;
	/** The folder the feature would use in this vault. */
	folder: string;
	/** Markdown notes already in that folder. */
	notes: number;
	/** Another device already uses the feature on this server. */
	serverOn: boolean;
}

const NAMES: Record<Feature, string> = { reminders: 'Reminders', reading: 'Reading' };
const STORED: Record<Feature, string> = {
	reminders: 'Crate stores your reminders and projects here as Markdown notes.',
	reading: 'Crate saves your articles and highlights here as Markdown notes.',
};
const CHANGES: Record<Feature, string> = {
	reminders: 'Turning this on adds a small ID comment to each task and turns dates like "tomorrow" into fixed dates.',
	reading: 'Turning this on adds Crate frontmatter to each note.',
};

/** A new or empty folder, or one another device already uses, starts on. */
function defaultFeatureChoice({ notes, serverOn }: FeatureChoice): boolean {
	return serverOn || notes === 0;
}

function describeFeatureChoice(choice: FeatureChoice): string {
	const { feature, folder, notes, serverOn } = choice;
	const change = notes === 0 ? STORED[feature] : `${notes} ${notes === 1 ? 'note' : 'notes'}. ${CHANGES[feature]}`;
	return `${folder}/ · ${serverOn ? `On for your other devices. ${change}` : change}`;
}

class FeatureChoiceModal extends SharedModal {
	private settled = false;

	constructor(app: App, private readonly choices: FeatureChoice[], private readonly resolve: (features: Feature[] | null) => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('crate-feature-choice-modal');
		this.openLayout('Choose what Crate manages in this vault');
		const selected = new Set(this.choices.filter(defaultFeatureChoice).map(choice => choice.feature));
		for (const choice of this.choices) {
			new Setting(this.bodyEl).setName(NAMES[choice.feature]).setDesc(describeFeatureChoice(choice))
				.addToggle(toggle => toggle.setValue(selected.has(choice.feature)).onChange(on => {
					if (on) selected.add(choice.feature);
					else selected.delete(choice.feature);
				}));
		}
		this.bodyEl.createEl('p', { text: 'You can change these later in Crate settings.', cls: 'crate-feature-choice-hint' });
		createModalActions(createModalFooter(this.contentEl))
			.addButton(button => button.setButtonText('Finish').setCta().onClick(() => {
				this.finish(this.choices.map(choice => choice.feature).filter(feature => selected.has(feature)));
			}));
	}

	onClose(): void {
		super.onClose();
		this.finish(null);
	}

	private finish(features: Feature[] | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(features);
		if (features) this.close();
	}
}

/** Resolves with the features turned on at Finish, or null when closed without it. */
export function openFeatureChoiceModal(app: App, choices: FeatureChoice[]): Promise<Feature[] | null> {
	return new Promise(resolve => { new FeatureChoiceModal(app, choices, resolve).open(); });
}
