import { ItemView, Platform, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import type CratePlugin from '@/main';
import { PluginContext } from '@/reminders/ui/reminders-context';
import { createShadowReactMount, type ShadowReactMount } from './shadowReactMount';
import { CRATE_ICON_ID } from '@/ui/crate-icon';
import { PluginWorkspace } from '@/ui/plugin/PluginWorkspace';
export const VIEW_TYPE_REMINDERS = "reminders-view";

export class RemindersView extends ItemView {
    private plugin: CratePlugin;
    private shadowMount: ShadowReactMount | null = null;
    private isOpen = false;
    private initialProject: string | undefined;
    private navigationVersion = 0;

    constructor(leaf: WorkspaceLeaf, plugin: CratePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_REMINDERS;
    }

    getDisplayText(): string {
        return "Reminders";
    }

    getIcon(): string {
        return CRATE_ICON_ID;
    }

    /**
     * Check if this view is in the main content area (not in sidebars)
     * Used to determine if we should render in full-screen mode on mobile
     */
    isInMainContent(): boolean {
        const workspaceWithSplits = this.app.workspace as typeof this.app.workspace & {
            rightSplit?: { children?: WorkspaceLeaf[] };
            leftSplit?: { children?: WorkspaceLeaf[] };
        };
        const rightSplit = workspaceWithSplits.rightSplit;
        const leftSplit = workspaceWithSplits.leftSplit;

        if (rightSplit?.children?.includes(this.leaf)) return false;
        if (leftSplit?.children?.includes(this.leaf)) return false;
        return true;
    }

    async onOpen(): Promise<void> {
        if (!this.plugin.remindersSettings.enabled) { this.leaf.detach(); return; }
        this.isOpen = true;
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("crate-reminders-view-container");

        const shadowMount = await createShadowReactMount(this.plugin, container, {
            isActive: () => this.isOpen,
        });
        if (!shadowMount) {
            return;
        }
        this.shadowMount = shadowMount;

        this.renderContent();
    }

    async setState(state: unknown, result: ViewStateResult): Promise<void> {
        if (typeof state === "object" && state !== null && "project" in state && typeof state.project === "string") {
            this.initialProject = state.project || undefined;
            this.navigationVersion++;
            this.renderContent();
        }
        await super.setState(state, result);
    }

    private renderContent(): void {
        const shadowMount = this.shadowMount;
        if (!shadowMount) return;
        // Determine if we're in full-screen mode (main content on mobile)
        const isFullScreen = Platform.isMobile && this.isInMainContent();

        shadowMount.render(
            <PluginContext.Provider value={this.plugin}>
                <PluginWorkspace
                    key={this.navigationVersion}
                    initialProject={this.initialProject}
                    plugin={this.plugin}
                    shadowRoot={shadowMount.shadowRoot}
                    isFullScreen={isFullScreen}
                    initialReminderTab={this.plugin.remindersSettings.sidebarDefaultTab}
                />
            </PluginContext.Provider>
        );
    }

    async onClose(): Promise<void> {
        this.isOpen = false;
        this.shadowMount?.unmount();
        this.shadowMount = null;
    }
}
