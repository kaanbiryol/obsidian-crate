import type CratePlugin from '../../main';

export interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export interface SetupWizardState {
	wizardToken: string;
	wizardTokenValidated: boolean;
	wizardSelectedAccountId: string;
}

export interface ConfigSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	wizardState: SetupWizardState;
	rerender: () => void;
}
