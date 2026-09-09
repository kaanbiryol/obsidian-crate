import { ItemView, Platform, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import React, { useCallback, useEffect, useState } from "react";
import type CratePlugin from "@/main";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { useObsidianDarkMode } from "@/reminders/ui/hooks/useObsidianDarkMode";
import { useObsidianStatusBarInset } from "@/reminders/ui/hooks/useObsidianStatusBarInset";
import type { TabId } from "@/reminders/ui/layoutConstants";
import { openReminderCreationModal } from "@/reminders/ui/adapters/modals";
import { createShadowReactMount, type ShadowReactMount } from "@/reminders/ui/adapters/shadowReactMount";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { RemindersViewCloseButton } from "@/reminders/ui/RemindersViewCloseButton";
import {
    PluginRemindersAppShell,
    type PluginReminderCardRenderer,
} from "@/reminders/ui/plugin/PluginRemindersAppShell";
import { persistReminderOrder } from "@/reminders/ui/plugin/persistReminderOrder";
import { PluginReminderSourceNotice } from '../plugin/PluginReminderSourceNotice';
import "../reminders-view.scss";

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
        return "check-circle";
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
                <RemindersViewContent
                    key={this.navigationVersion}
                    initialProject={this.initialProject}
                    plugin={this.plugin}
                    shadowRoot={shadowMount.shadowRoot}
                    isFullScreen={isFullScreen}
                    initialTab={this.plugin.remindersSettings.sidebarDefaultTab}
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

interface RemindersViewContentProps {
    plugin: CratePlugin;
    shadowRoot: ShadowRoot;
    isFullScreen?: boolean;
    isModal?: boolean;
    onClose?: () => void;
    initialTab?: TabId;
    initialProject?: string;
    hideTabBar?: boolean;
    renderHeader?: (title: string) => React.ReactNode;
}

export const RemindersViewContent: React.FC<RemindersViewContentProps> = ({ plugin, shadowRoot, isFullScreen = false, onClose, isModal = Boolean(onClose), initialTab, initialProject, hideTabBar = false, renderHeader }) => {
    const isDarkMode = useObsidianDarkMode();
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);
    useObsidianStatusBarInset(shadowRoot, !isModal);

    // Subscribe to index changes for automatic refresh (replaces 5-second polling)
    const { refreshToken, triggerRefresh } = useIndexRefresh();

    // Get all reminders from the repository.
    const updateReminders = useCallback(() => {
        const allReminders = plugin.reminderRepository.getAll();
        setReminders(allReminders);
        setIsInitialLoadComplete(true);
    }, [plugin]);

    // Load reminders when index changes
    useEffect(() => {
        updateReminders();
    }, [updateReminders, refreshToken]);

    const handleAdd = useCallback((defaultProject: string) => {
        openReminderCreationModal(plugin, defaultProject, updateReminders);
    }, [plugin, updateReminders]);

    const renderCard = useCallback<PluginReminderCardRenderer>(({ reminder, index, hideProject }) => (
        <ReminderCardWrapper
            key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
            reminder={reminder}
            onUpdate={triggerRefresh}
            index={index}
            hideProject={hideProject}
            colorScheme={isDarkMode ? "dark" : "light"}
        />
    ), [isDarkMode, triggerRefresh]);

    const handleReorder = useCallback(async (project: string, orderedIds: string[]) => {
        await persistReminderOrder(
            plugin.reminderRepository,
            project,
            orderedIds,
            updateReminders,
        );
        updateReminders();
    }, [plugin, updateReminders]);

    return (
        <PluginRemindersAppShell
            reminders={reminders}
            isInitialLoadComplete={isInitialLoadComplete}
            isDarkMode={isDarkMode}
            isFullScreen={isFullScreen}
            isModal={isModal}
            isCompact={hideTabBar}
            initialTab={initialTab}
            initialProject={initialProject}
            hideTabBar={hideTabBar}
            renderHeader={renderHeader}
            upcomingDays={plugin.remindersSettings.upcomingDaysDefault ?? 7}
            renderCard={renderCard}
            onAdd={handleAdd}
            onReorder={handleReorder}
            belowHeaderContent={<PluginReminderSourceNotice
                issues={plugin.reminderIndex.sourceIssues}
                onRefresh={() => plugin.reminderIndex.load()}
            />}
            topOverlay={onClose ? (
                <>
                    <RemindersViewCloseButton
                        onClose={onClose}
                    />
                </>
            ) : undefined}
        />
    );
};
