import type CratePlugin from '../../main';

export interface InfrastructureSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	isConfigured: boolean;
	rerender: () => void;
}
