import type CratePlugin from '../../main';

export interface ConfigSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}
