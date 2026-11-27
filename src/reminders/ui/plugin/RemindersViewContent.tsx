import { useRemindersSettingsStore } from '@/reminders/settings';
import React, { useCallback } from "react";
import { TFile } from 'obsidian';
import { useReminderRepository } from "@/reminders/ui/plugin/hooks/useReminderRepository";
import { useObsidianDarkMode } from "@/reminders/ui/plugin/hooks/useObsidianDarkMode";
import type { TabId } from "@/reminders/ui/shared/layoutConstants";
import { openReminderCreationModal } from "@/reminders/ui/plugin/reminder-modal/reminderEditorModals";
import { ReminderCardWrapper } from "@/reminders/ui/plugin/ReminderCardWrapper";
import { RemindersViewCloseButton } from "@/reminders/ui/plugin/RemindersViewCloseButton";
import { PluginContext } from "@/ui/plugin/plugin-context";
import { PluginRemindersAppShell } from "@/reminders/ui/plugin/PluginRemindersAppShell";
import type { ReminderCardRenderer } from "@/reminders/ui/shared/useRemindersShellModel";
import { persistReminderOrder } from "@/reminders/ui/plugin/persistReminderOrder";
import { requireReminderBackend, type ReminderBackend } from "@/reminders/runtime";
import { PluginReminderSourceNotice } from './PluginReminderSourceNotice';
import { RemindersLoading } from "./RemindersLoading";
import "./styles/reminders-view.scss";

import { ReminderPageSizeContext } from '@/reminders/ui/shared/reminder-pagination';
interface RemindersViewContentProps {
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

// Startup sync can defer the index scan even after the view is registered.
// Select readiness with its reminders so no render sees a stale empty list.
const selectView = (backend: ReminderBackend | undefined) => ({
	reminders: backend?.repository.getAll() ?? [],
	isInitialLoadComplete: backend?.index.isInitialLoadComplete ?? false,
	sourceIssues: backend?.index.sourceIssues ?? [],
});

export const RemindersViewContent: React.FC<RemindersViewContentProps> = ({ isFullScreen = false, onClose, isModal = Boolean(onClose), initialTab, initialProject, hideTabBar = false, renderHeader, activeTab, onTabChange, renderNavigation }) => {
	const plugin = PluginContext.use();
	const listStyle = useRemindersSettingsStore(state => state.listStyle);
	const upcomingDays = useRemindersSettingsStore(state => state.upcomingDaysDefault);
	const isDarkMode = useObsidianDarkMode();
	const [{ reminders, isInitialLoadComplete, sourceIssues }, refresh] = useReminderRepository(selectView);

	const handleAdd = useCallback((defaultProject: string) => {
		openReminderCreationModal(plugin, defaultProject, refresh);
	}, [plugin, refresh]);

	const renderCard = useCallback<ReminderCardRenderer>(({ reminder, hideProject }) => (
		<ReminderCardWrapper
			key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
			reminder={reminder}
			onUpdate={refresh}
			hideProject={hideProject}
			colorScheme={isDarkMode ? "dark" : "light"}
		/>
	), [isDarkMode, refresh]);

	const handleReorder = useCallback(async (project: string, orderedIds: string[]) => {
		await persistReminderOrder(
			requireReminderBackend(plugin).repository,
			project,
			orderedIds,
			refresh,
		);
		refresh();
	}, [plugin, refresh]);

	return (
		// Large folders render in pages, matching the web app.
		<ReminderPageSizeContext.Provider value={200}><PluginRemindersAppShell
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
			upcomingDays={upcomingDays}
			renderCard={renderCard}
			onAdd={handleAdd}
			onReorder={handleReorder}
			belowHeaderContent={<PluginReminderSourceNotice
				issues={sourceIssues}
				onRefresh={() => requireReminderBackend(plugin).index.load()}
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
		/></ReminderPageSizeContext.Provider>
	);
};
