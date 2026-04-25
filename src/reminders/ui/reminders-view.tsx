import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type CratePlugin from "@/main";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { useObsidianDarkMode } from "@/reminders/ui/hooks/useObsidianDarkMode";
import { attachPluginStylesheet } from "@/reminders/ui/shadowStyles";
import type { TabId } from "@/reminders/ui/layoutConstants";
import { openReminderCreationModal } from "@/reminders/ui/modals";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { RemindersViewCloseButton } from "./RemindersViewCloseButton";
import { RemindersAppShell, type ReminderCardRenderer } from "./RemindersAppShell";
import "./reminders-view.scss";

export const VIEW_TYPE_REMINDERS = "reminders-view";

export class RemindersView extends ItemView {
    private root: Root | null = null;
    private plugin: CratePlugin;
    private shadowRoot: ShadowRoot | null = null;

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
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("reminders-view-container");

        // CRITICAL: Force height chain to work
        // Obsidian's container is a flex child, so height: 100% will resolve
        container.setCssProps({
            height: "100%",
            overflow: "hidden",
        });

        // Create shadow root for CSS isolation from Obsidian's styles
        this.shadowRoot = container.attachShadow({ mode: "open" });
        await attachPluginStylesheet(this.plugin, this.shadowRoot);

        // Create mount point inside shadow DOM
        const mountPoint = document.createElement("div");
        mountPoint.className = "reminders-shadow-root";
        this.shadowRoot.appendChild(mountPoint);

        // Determine if we're in full-screen mode (main content on mobile)
        const isFullScreen = Platform.isMobile && this.isInMainContent();

        // Render React into shadow DOM
        this.root = createRoot(mountPoint);
        this.root.render(
            <PluginContext.Provider value={this.plugin}>
                <RemindersViewContent
                    plugin={this.plugin}
                    shadowRoot={this.shadowRoot}
                    isFullScreen={isFullScreen}
                    initialTab={this.plugin.remindersSettings.sidebarDefaultTab}
                />
            </PluginContext.Provider>
        );
    }

    async onClose(): Promise<void> {
        if (this.root) {
            this.root.unmount();
            this.root = null;
        }
        this.shadowRoot = null;
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
