import type CratePlugin from '../../../plugin/CratePlugin';

export interface ConfigSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}
