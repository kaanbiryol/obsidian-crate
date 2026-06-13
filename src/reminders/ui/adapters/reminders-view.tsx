import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type CratePlugin from "@/main";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { useObsidianDarkMode } from "@/reminders/ui/hooks/useObsidianDarkMode";
import type { TabId } from "@/reminders/ui/layoutConstants";
import { openReminderCreationModal } from "@/reminders/ui/adapters/modals";
import { createShadowReactMount, type ShadowReactMount } from "@/reminders/ui/adapters/shadowReactMount";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { RemindersViewCloseButton } from "@/reminders/ui/RemindersViewCloseButton";
import { RemindersAppShell, type ReminderCardRenderer } from "@/reminders/ui/RemindersAppShell";
import "../reminders-view.scss";

export const VIEW_TYPE_REMINDERS = "reminders-view";

export class RemindersView extends ItemView {
    private plugin: CratePlugin;
    private shadowMount: ShadowReactMount | null = null;
    private isOpen = false;

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
        container.addClass("reminders-view-container");

        // CRITICAL: Force height chain to work
        // Obsidian's container is a flex child, so height: 100% will resolve
        container.setCssProps({
            height: "100%",
            overflow: "hidden",
        });

        const shadowMount = await createShadowReactMount(this.plugin, container, {
            isActive: () => this.isOpen,
        });
        if (!shadowMount) {
            return;
        }
        this.shadowMount = shadowMount;

        // Determine if we're in full-screen mode (main content on mobile)
        const isFullScreen = Platform.isMobile && this.isInMainContent();

        shadowMount.render(
            <PluginContext.Provider value={this.plugin}>
                <RemindersViewContent
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
    onClose?: () => void;
    initialTab?: TabId;
    initialProject?: string;
    hideTabBar?: boolean;
}

export const RemindersViewContent: React.FC<RemindersViewContentProps> = ({ plugin, shadowRoot, isFullScreen = false, onClose, initialTab, initialProject, hideTabBar = false }) => {
    const isDarkMode = useObsidianDarkMode();
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);

    // Create portal container ref inside shadow DOM for HeroUI popovers/modals
    const portalContainerRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        // Create portal container inside shadow root if it doesn't exist
        let portalContainer = shadowRoot.querySelector(".heroui-portal-container") as HTMLDivElement;
        if (!portalContainer) {
            portalContainer = document.createElement("div");
            portalContainer.className = "heroui-portal-container";
            shadowRoot.appendChild(portalContainer);
        }
        portalContainerRef.current = portalContainer;

        // Update dark mode class on portal container
        if (isDarkMode) {
            portalContainer.classList.add("dark");
        } else {
            portalContainer.classList.remove("dark");
        }
    }, [shadowRoot, isDarkMode]);

    // Subscribe to index changes for automatic refresh (replaces 5-second polling)
    const { refreshToken, triggerRefresh } = useIndexRefresh();

    // Get all reminders from storage
    const updateReminders = useCallback(() => {
        const allReminders = plugin.storage.getAll();
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

    const renderCard = useCallback<ReminderCardRenderer>(({ reminder, index, hideProject }) => (
        <ReminderCardWrapper
            key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
            reminder={reminder}
            onUpdate={triggerRefresh}
            index={index}
            hideProject={hideProject}
        />
    ), [triggerRefresh]);

    const handleReorder = useCallback(async (project: string, orderedIds: string[]) => {
        await plugin.storage.reorder(project, orderedIds);
    }, [plugin]);

    return (
        <RemindersAppShell
            reminders={reminders}
            isInitialLoadComplete={isInitialLoadComplete}
            isDarkMode={isDarkMode}
            isFullScreen={isFullScreen}
            isModal={Boolean(onClose)}
            isCompact={hideTabBar}
            initialTab={initialTab}
            initialProject={initialProject}
            hideTabBar={hideTabBar}
            upcomingDays={plugin.remindersSettings.upcomingDaysDefault ?? 7}
            renderCard={renderCard}
            onAdd={handleAdd}
            onReorder={handleReorder}
            topOverlay={onClose ? (
                <>
                    <RemindersViewCloseButton
                        isDarkMode={isDarkMode}
                        onClose={onClose}
                    />
                </>
            ) : undefined}
        />
    );
};
