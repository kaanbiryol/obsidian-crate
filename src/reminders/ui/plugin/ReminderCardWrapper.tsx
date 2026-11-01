/**
 * Plugin Wrapper for ReminderCard
 *
 * Adapts the shared ReminderCard component to the plugin's API with platform-specific behavior:
 * - animations disabled (parent handles animations via Framer Motion)
 * - Integrates with the reminder repository and modal system
 */
import { Notice } from 'obsidian';
import React, { useCallback } from 'react';
import { ReminderCard as SharedReminderCard } from '@/reminders/ui/shared/ReminderCard';
import { useReminderCardInteractions } from '@/reminders/ui/shared/useReminderCardInteractions';
import { createLogger } from '@/reminders/logger';
import { errorMessage } from '@/platform/logger';

const log = createLogger('ReminderCardWrapper');
import type { Reminder } from '@/reminders/types/reminder';
import { PluginContext } from '@/reminders/ui/plugin/reminders-context';
import { openReminderEditModal } from '@/reminders/ui/plugin/reminder-modal/reminderEditorModals';
import { requireReminderBackend } from '@/reminders/runtime';
import type { ProjectColorScheme } from '@/reminders/ui/format/projectColors';
import { useRemindersSettingsStore } from '@/reminders/settings';

interface ReminderCardWrapperProps {
	reminder: Reminder;
	onUpdate?: () => void;
	index?: number;
	hideProject?: boolean;
	colorScheme: ProjectColorScheme;
}

/**
 * Plugin-specific wrapper for ReminderCard
 *
 * Provides Obsidian-specific handlers for toggle, delete, and edit operations.
 * Optimistic updates are handled by ReminderIndex.
 */
export const ReminderCardWrapper = React.memo(function ReminderCardWrapper({
	reminder,
	onUpdate,
	index,
	hideProject = false,
	colorScheme,
}: ReminderCardWrapperProps) {
	const plugin = PluginContext.use();
	const listStyle = useRemindersSettingsStore(state => state.listStyle);

	/**
	 * Handle reminder completion toggle
	 * Optimistic updates are handled by ReminderIndex
	 */
	const handleToggle = useCallback(async () => {
		try {
			if (reminder.completed) {
				await requireReminderBackend(plugin).repository.uncomplete(reminder.id);
			} else {
				await requireReminderBackend(plugin).repository.complete(reminder.id);
			}
		} catch (error) {
			log.error('Failed to toggle reminder', error);
			new Notice(errorMessage(error));
		}
	}, [plugin, reminder]);

	/**
	 * Handle reminder edit
	 */
	const handleEdit = useCallback(() => {
		openReminderEditModal(plugin, reminder, onUpdate ?? (() => undefined));
	}, [onUpdate, plugin, reminder]);

	const { wrapperRef, completionPreview } = useReminderCardInteractions({
		completed: reminder.completed,
		onEdit: handleEdit,
		onToggleComplete: handleToggle,
	});

	return (
		<div
			ref={wrapperRef}
			className="sidebar-reminder-card-wrapper is-interactive"
			role="group"
			tabIndex={0}
			aria-label={`${reminder.content}. Press Enter to edit reminder.`}
		>
			<SharedReminderCard
				listStyle={listStyle}
				reminder={reminder}
				completionPreview={completionPreview}
				animationConfig={{ enabled: false }}
				index={index}
				hideProject={hideProject}
				colorScheme={colorScheme}
			/>
		</div>
	);
});
