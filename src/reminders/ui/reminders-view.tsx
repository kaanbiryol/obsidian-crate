import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import React, { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { AnimatePresence, motion, type Easing } from "framer-motion";
import { X, ChevronDown } from "lucide-react";
import type CratePlugin from "@/main";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { attachPluginStylesheet } from "@/reminders/ui/shadowStyles";
import { HeroUIProvider } from "@heroui/react";
import {
    isReminderOverdue,
    getUpcomingReminders,
    getTodayReminders,
    getOverdueReminders,
    BottomTabBar,
    FloatingActionButton,
    ViewHeader,
    InboxView,
    TodayView,
    UpcomingView,
    BrowseView,
    ProjectDetailView,
    DEFAULT_PROJECT,
    EASE_EXPO_OUT,
    PAGE_TRANSITION_DURATION,
    type TabId,
    type Reminder as SharedReminder
} from "@/reminders";
import { openReminderCreationModal } from "@/reminders/ui/modals";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import { ShadowDOMButton, ShadowDOMNativeButton } from "@/reminders/components/ShadowDOMButton";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import "./reminders-view.scss";

// Hook to detect Obsidian's dark/light theme
function useObsidianDarkMode(): boolean {
    const [isDark, setIsDark] = useState(() => document.body.classList.contains("theme-dark"));

    useEffect(() => {
        const observer = new MutationObserver(() => {
            setIsDark(document.body.classList.contains("theme-dark"));
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        return () => observer.disconnect();
    }, []);

    return isDark;
}

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

// Map shared TabId to plugin ViewMode
type ViewMode = TabId;

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

    // Glass styling for close button based on theme
    const glassButtonBg = isDarkMode
        ? 'rgba(255, 255, 255, 0.04)'
        : 'rgba(0, 0, 0, 0.03)';
    const glassButtonBorder = isDarkMode
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.06)';
    const glassButtonHoverBg = isDarkMode
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.06)';
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
        const uniqueProjects = Array.from(
            new Set(reminders.map((r) => r.project || DEFAULT_PROJECT))
        ).sort();
        return uniqueProjects;
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
        const effectiveDays = plugin.remindersSettings.upcomingDaysDefault ?? 7;
        const activeReminders = reminders.filter(r => !r.completed);

        // Inbox: reminders in Inbox project
        const inboxReminders = activeReminders.filter(r => (r.project || DEFAULT_PROJECT) === DEFAULT_PROJECT);
        const inboxOverdue = inboxReminders.filter(r => isReminderOverdue(r)).length;

        // Today: reminders due today or overdue
        const todayList = getTodayReminders(activeReminders);
        const overdueList = getOverdueReminders(activeReminders);
        const todayCombined = [...new Map([...overdueList, ...todayList].map(r => [r.id, r])).values()];
        const todayOverdue = overdueList.length;

        // Upcoming: reminders in next N days
        const upcomingReminders = getUpcomingReminders(activeReminders, effectiveDays);
        const upcomingOverdue = upcomingReminders.filter(r => isReminderOverdue(r)).length;

        return {
            inbox: { count: inboxReminders.length, overdueCount: inboxOverdue },
            today: { count: todayCombined.length, overdueCount: todayOverdue },
            upcoming: { count: upcomingReminders.length, overdueCount: upcomingOverdue },
            browse: { count: projects.length, overdueCount: 0 },
        };
    }, [reminders, projects, plugin.remindersSettings.upcomingDaysDefault]);

    // Get current header based on view mode
    const getCurrentHeader = () => {
        switch (viewMode) {
            case "inbox":
                return { title: "Inbox", ...headerData.inbox };
            case "today":
                return { title: "Today", ...headerData.today };
            case "upcoming":
                return { title: "Upcoming", ...headerData.upcoming };
            case "browse":
                return { title: "Projects", count: headerData.browse.count, overdueCount: 0 };
        }
    };

    // Handle FAB click
    const handleAdd = useCallback(() => {
        const defaultProject = viewMode === "inbox" || viewMode === "browse"
            ? (selectedProject || DEFAULT_PROJECT)
            : DEFAULT_PROJECT;
        openReminderCreationModal(plugin, defaultProject, updateReminders);
    }, [plugin, viewMode, selectedProject, updateReminders]);

    // Determine whether to show FAB
    const showFab = viewMode !== "browse" || selectedProject !== null;

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
    const currentProject = viewMode === "inbox"
        ? DEFAULT_PROJECT
        : (viewMode === "browse" && selectedProject ? selectedProject : null);

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
                    <ShadowDOMNativeButton
                        onClick={onClose}
                        className="flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 active:scale-95"
                        aria-label="Close"
                        style={{
                            position: 'absolute',
                            top: '12px',
                            right: '16px',
                            zIndex: 100,
                            background: glassButtonBg,
                            backdropFilter: 'blur(8px)',
                            WebkitBackdropFilter: 'blur(8px)',
                            border: `1px solid ${glassButtonBorder}`,
                            color: 'var(--text-muted)',
                            boxShadow: `0 2px 8px ${isDarkMode ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.04)'}`,
                            transition: 'all 200ms ease-out',
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = glassButtonHoverBg;
                            e.currentTarget.style.boxShadow = `0 0 12px ${isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'}`;
                        }}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = glassButtonBg;
                            e.currentTarget.style.boxShadow = `0 2px 8px ${isDarkMode ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.04)'}`;
                        }}
                    >
                        <X size={24} strokeWidth={2.5} />
                    </ShadowDOMNativeButton>
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
                        {(() => {
                            const tabContainerStyle: React.CSSProperties = {
                                display: "flex",
                                height: "100%",
                                flexDirection: "column",
                            };

                            // Unified page transition props - simple fade
                            const easeExpoOut = EASE_EXPO_OUT as unknown as Easing;
                            const pageTransition = {
                                initial: { opacity: 0 },
                                animate: { opacity: 1 },
                                exit: { opacity: 0 },
                                transition: {
                                    duration: PAGE_TRANSITION_DURATION,
                                    ease: easeExpoOut
                                }
                            };

                            switch (viewMode) {
                                case "inbox":
                                    return (
                                        <motion.div
                                            key="inbox"
                                            style={tabContainerStyle}
                                            {...pageTransition}
                                        >
                                            <InboxView
                                                reminders={reminders}
                                                renderCard={renderCard}
                                                renderToggleButton={renderToggleButton}
                                                hasFab={showFab}
                                                onReorder={handleReorder}
                                            />
                                        </motion.div>
                                    );
                                case "today":
                                    return (
                                        <motion.div
                                            key="today"
                                            style={tabContainerStyle}
                                            {...pageTransition}
                                        >
                                            <TodayView
                                                reminders={reminders}
                                                renderCard={renderCard}
                                                hasFab={showFab}
                                            />
                                        </motion.div>
                                    );
                                case "upcoming":
                                    return (
                                        <motion.div
                                            key="upcoming"
                                            style={tabContainerStyle}
                                            {...pageTransition}
                                        >
                                            <UpcomingView
                                                reminders={reminders}
                                                renderCard={renderCard}
                                                days={plugin.remindersSettings.upcomingDaysDefault ?? 7}
                                                hasFab={showFab}
                                            />
                                        </motion.div>
                                    );
                                case "browse":
                                    if (!selectedProject) {
                                        return (
                                            <motion.div
                                                key="browse"
                                                style={tabContainerStyle}
                                                {...pageTransition}
                                            >
                                                <BrowseView
                                                    projects={projects}
                                                    reminders={reminders}
                                                    onProjectSelect={handleProjectSelect}
                                                />
                                            </motion.div>
                                        );
                                    }

                                    if (isInitialLoadComplete) {
                                        return (
                                            <motion.div
                                                key={`project-${selectedProject}`}
                                                style={tabContainerStyle}
                                                {...pageTransition}
                                            >
                                                <ProjectDetailView
                                                    project={selectedProject}
                                                    reminders={reminders}
                                                    onBack={handleBackToProjects}
                                                    animationConfig={{ enabled: false }}
                                                    renderCard={renderCard}
                                                    hasFab={showFab}
                                                    onReorder={handleReorder}
                                                />
                                            </motion.div>
                                        );
                                    }

                                    return null;
                            }
                        })()}
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
