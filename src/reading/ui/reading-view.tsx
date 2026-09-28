import { ItemView, Platform, type WorkspaceLeaf } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { createShadowReactMount, type ShadowReactMount } from '../../reminders/ui/adapters/shadowReactMount';
import { getReadingLibrary } from '../runtime';
import { PluginWorkspace } from '@/ui/plugin/PluginWorkspace';
export const READING_VIEW_TYPE = 'crate-reading';
export class ReadingView extends ItemView {
	private mount: ShadowReactMount | null = null;
	private active = false;
	constructor(leaf: WorkspaceLeaf, private plugin: CratePlugin) { super(leaf); }
	getViewType(): string { return READING_VIEW_TYPE; }
	getDisplayText(): string { return 'Reading'; }
	getIcon(): string { return 'book-open'; }
	async onOpen(): Promise<void> {
		const library = getReadingLibrary(this.plugin);
		if (!library) { this.leaf.detach(); return; }
		this.active = true;
		this.contentEl.empty(); this.contentEl.addClass('crate-reading-view');
		const host = this.contentEl.createDiv({ cls: 'crate-reading-view' });
		this.mount = await createShadowReactMount(this.plugin, host, { mountClassName: 'crate-reading-mount', isActive: () => this.active });
		if (this.mount) this.mount.render(<PluginWorkspace plugin={this.plugin} shadowRoot={this.mount.shadowRoot} initialSection="reading" isFullScreen={Platform.isMobile} />);
	}
	async onClose(): Promise<void> { this.active = false; this.mount?.unmount(); this.mount = null; }
}
