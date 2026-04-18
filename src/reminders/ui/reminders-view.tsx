import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import React, { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import type CratePlugin from "@/main";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { useObsidianDarkMode } from "@/reminders/ui/hooks/useObsidianDarkMode";
import { attachPluginStylesheet } from "@/reminders/ui/shadowStyles";
import { HeroUIProvider } from "@heroui/react";
import {
    BottomTabBar,
    FloatingActionButton,
    ViewHeader,
    DEFAULT_PROJECT,
    PAGE_TRANSITION_DURATION,
    type TabId,
    type Reminder as SharedReminder
} from "@/reminders";
import { openReminderCreationModal } from "@/reminders/ui/modals";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import { ShadowDOMButton, ShadowDOMNativeButton } from "@/reminders/components/ShadowDOMButton";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { RemindersViewCloseButton } from "./RemindersViewCloseButton";
import { RemindersViewPanels } from "./RemindersViewPanels";
import {
    getCurrentHeaderData,
    getReminderCreateProject,
    getReminderProjects,
    getRemindersHeaderData,
    getReorderProject,
    shouldShowReminderFab,
    type ViewMode,
} from "./remindersViewModel";
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
    const [viewMode, setViewMode] = useState<ViewMode>(initialProject ? "browse" : (initialTab ?? "inbox"));
    const [isTransitioning, setIsTransitioning] = useState(false);
    const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [selectedProject, setSelectedProject] = useState<string | null>(initialProject ?? null);
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

    useEffect(() => {
        return () => {
            if (transitionTimeoutRef.current) {
                clearTimeout(transitionTimeoutRef.current);
            }
        };
    }, []);

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

    // Get unique projects from reminders
    const projects = useMemo(() => {
        return getReminderProjects(reminders);
    }, [reminders]);

    const startTransition = useCallback(() => {
        // Hide scrollbars during transitions to prevent flicker/jitter
        setIsTransitioning(true);

        if (transitionTimeoutRef.current) {
            clearTimeout(transitionTimeoutRef.current);
        }

        transitionTimeoutRef.current = setTimeout(() => {
            setIsTransitioning(false);
        }, PAGE_TRANSITION_DURATION * 1000);
    }, []);

    const handleViewModeChange = (mode: ViewMode) => {
        startTransition();
        setViewMode(mode);
        // Reset selected project when switching tabs
        if (mode !== "browse") {
            setSelectedProject(null);
        }
    };

    const handleProjectSelect = (project: string) => {
        startTransition();
        setSelectedProject(project);
    };

    const handleBackToProjects = () => {
        startTransition();
        setSelectedProject(null);
    };

    // Calculate header data for each tab
    const headerData = useMemo(() => {
        return getRemindersHeaderData(
            reminders,
            projects,
            plugin.remindersSettings.upcomingDaysDefault ?? 7,
        );
    }, [reminders, projects, plugin.remindersSettings.upcomingDaysDefault]);

    // Get current header based on view mode
    const getCurrentHeader = () => {
        return getCurrentHeaderData(viewMode, headerData);
    };

    // Handle FAB click
    const handleAdd = useCallback(() => {
        const defaultProject = getReminderCreateProject(viewMode, selectedProject);
        openReminderCreationModal(plugin, defaultProject, updateReminders);
    }, [plugin, viewMode, selectedProject, updateReminders]);

    // Determine whether to show FAB
    const showFab = shouldShowReminderFab(viewMode, selectedProject);

    // Create custom card renderer that uses ReminderCardWrapper
    const renderCard = useCallback((reminder: SharedReminder, index: number) => (
        <ReminderCardWrapper
            key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
            reminder={reminder}
            onUpdate={triggerRefresh}
            index={index}
            hideProject={viewMode === "browse" && selectedProject !== null}
        />
    ), [triggerRefresh, viewMode, selectedProject]);

    // Custom toggle button renderer for Shadow DOM compatibility
    const renderToggleButton = useCallback(({ onPress, showCompleted, count }: {
        onPress: () => void;
        showCompleted: boolean;
        count: number;
    }) => (
        <ShadowDOMButton
            variant="light"
            onPress={onPress}
            className="w-full justify-between h-10 px-0"
            endContent={
                <motion.span
                    animate={{ rotate: showCompleted ? 180 : 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="inline-flex"
                >
                    <ChevronDown size={18} />
                </motion.span>
            }
        >
            <span className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
                Completed ({count})
            </span>
        </ShadowDOMButton>
    ), []);

    // Determine current project for reorder
    const currentProject = getReorderProject(viewMode, selectedProject);

    const handleReorder = useCallback(async (orderedIds: string[]) => {
        if (!currentProject) return;
        await plugin.storage.reorder(currentProject, orderedIds);
    }, [plugin, currentProject]);

    return (
        <HeroUIProvider>
            <div
                className={`reminders-view ${isDarkMode ? "dark" : ""} ${isFullScreen ? "is-fullscreen" : ""} ${onClose ? "is-modal" : ""} ${hideTabBar ? "is-compact" : ""}`}
            >
                {/* Close button for modal mode */}
                {onClose && (
                    <RemindersViewCloseButton
                        isDarkMode={isDarkMode}
                        onClose={onClose}
                    />
                )}

                {/* Tab Header - hide when in project detail view */}
                <AnimatePresence initial={false}>
                    {!(viewMode === "browse" && selectedProject) && (
                        <motion.div
                            key="view-header"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{
                                height: { duration: PAGE_TRANSITION_DURATION, ease: "easeOut" },
                                opacity: { duration: 0.18, ease: "easeOut" }
                            }}
                            style={{ overflow: "hidden" }}
                        >
                            <ViewHeader
                                {...getCurrentHeader()}
                                large={isFullScreen}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Content - Scrollable */}
                <div className={`reminders-content${isTransitioning ? ' is-transitioning' : ''}`}>
                    <AnimatePresence mode="sync">
                        <RemindersViewPanels
                            viewMode={viewMode}
                            selectedProject={selectedProject}
                            isInitialLoadComplete={isInitialLoadComplete}
                            reminders={reminders}
                            projects={projects}
                            showFab={showFab}
                            plugin={plugin}
                            renderCard={renderCard}
                            renderToggleButton={renderToggleButton}
                            onProjectSelect={handleProjectSelect}
                            onBackToProjects={handleBackToProjects}
                            onReorder={handleReorder}
                        />
                    </AnimatePresence>
                </div>

                {/* Bottom Tab Bar */}
                {!hideTabBar && (
                    <BottomTabBar
                        activeTab={viewMode}
                        onTabChange={handleViewModeChange}
                        className="animated-tab-bar animated-tab-bar-bottom"
                    />
                )}

                {/* Floating Action Button */}
                <AnimatePresence>
                    {showFab && (
                        <FloatingActionButton
                            onClick={handleAdd}
                        />
                    )}
                </AnimatePresence>
            </div>
        </HeroUIProvider>
    );
};
