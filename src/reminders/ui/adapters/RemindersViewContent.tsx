import { useRemindersSettingsStore } from '@/reminders/settings';
import React, { useCallback, useEffect, useState } from "react";
import { TFile } from 'obsidian';
import type CratePlugin from "@/main";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { useObsidianDarkMode } from "@/reminders/ui/hooks/useObsidianDarkMode";
import type { TabId } from "@/reminders/ui/layoutConstants";
import { openReminderCreationModal } from "@/reminders/ui/adapters/reminderEditorModals";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import { RemindersViewCloseButton } from "@/reminders/ui/RemindersViewCloseButton";
import {
    PluginRemindersAppShell,
    type PluginReminderCardRenderer,
} from "@/reminders/ui/plugin/PluginRemindersAppShell";
import { persistReminderOrder } from "@/reminders/ui/plugin/persistReminderOrder";
import { PluginReminderSourceNotice } from '../plugin/PluginReminderSourceNotice';
import { RemindersLoading } from "../RemindersLoading";
import "../reminders-view.scss";

import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import { ObsidianIcon } from '@/reminders/components/obsidian-icon';
interface RemindersViewContentProps {
    plugin: CratePlugin;
    isFullScreen?: boolean;
    isModal?: boolean;
    onClose?: () => void;
    initialTab?: TabId;
    initialProject?: string;
    hideTabBar?: boolean;
    activeTab?: TabId;
    onTabChange?: (tab: TabId) => void;
    renderNavigation?: React.ComponentProps<typeof PluginRemindersAppShell>['renderNavigation'];
    renderHeader?: React.ComponentProps<typeof PluginRemindersAppShell>['renderHeader'];
}

export const RemindersViewContent: React.FC<RemindersViewContentProps> = ({ plugin, isFullScreen = false, onClose, isModal = Boolean(onClose), initialTab, initialProject, hideTabBar = false, renderHeader, activeTab, onTabChange, renderNavigation }) => {
    const listStyle = useRemindersSettingsStore(state => state.listStyle);
    const isDarkMode = useObsidianDarkMode();
    // Startup sync can defer the index scan even after the view is registered.
    // Publish readiness with its reminders so no render sees a stale empty list.
    const readSnapshot = useCallback(() => ({
        reminders: plugin.reminderRepository.getAll(),
        isInitialLoadComplete: plugin.reminderIndex.isInitialLoadComplete,
    }), [plugin]);
    const [{ reminders, isInitialLoadComplete }, setSnapshot] = useState(readSnapshot);

    // Subscribe to index changes for automatic refresh (replaces 5-second polling)
    const { refreshToken, triggerRefresh } = useIndexRefresh();

    // Get all reminders from the repository.
    const updateReminders = useCallback(() => {
        setSnapshot(readSnapshot());
    }, [readSnapshot]);

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
        <ThemeIconProvider renderer={ObsidianIcon}><PluginRemindersAppShell
            listStyle={listStyle}
            activeTab={activeTab}
            onTabChange={onTabChange}
            renderNavigation={renderNavigation}
            reminders={reminders}
            isInitialLoadComplete={isInitialLoadComplete}
            loadingContent={!isInitialLoadComplete ? <RemindersLoading /> : undefined}
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
                onOpenNote={async path => {
                    const file = plugin.app.vault.getAbstractFileByPath(path);
                    if (!(file instanceof TFile)) throw new Error('This note is no longer available. Retry the scan to update the list.');
                    await plugin.app.workspace.getLeaf(false).openFile(file);
                    onClose?.();
                }}
            />}
            topOverlay={onClose ? (
                <>
                    <RemindersViewCloseButton
                        onClose={onClose}
                    />
                </>
            ) : undefined}
        /></ThemeIconProvider>
    );
};
