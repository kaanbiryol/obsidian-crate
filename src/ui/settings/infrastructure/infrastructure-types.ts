import type CratePlugin from '../../../plugin/CratePlugin';

export interface InfrastructureSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	isConfigured: boolean;
	rerender: () => void;
}
