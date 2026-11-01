import React, { memo } from 'react';
import { ReminderCard as SharedReminderCard } from '@/reminders/ui/shared/ReminderCard';
import { useReminderCardInteractions } from '@/reminders/ui/shared/useReminderCardInteractions';
import type { Reminder as SharedReminder } from '@/reminders/types/reminder';
import type { ListStyle } from '@/ui/shared/list-style';
import type { ProjectColorScheme } from '@/reminders/ui/format/projectColors';

export const WebReminderCard = memo(function WebReminderCard({
	reminder,
	listStyle,
	colorScheme,
	index,
	hideProject,
	onEdit,
	onToggleComplete,
}: {
	reminder: SharedReminder;
	listStyle?: ListStyle;
	colorScheme: ProjectColorScheme;
	index: number;
	hideProject: boolean;
	onEdit: (id: string) => void;
	onToggleComplete: (id: string, completed: boolean) => void | Promise<void>;
}) {
	const { wrapperRef, completionPreview } = useReminderCardInteractions({
		completed: reminder.completed,
		onEdit: () => onEdit(reminder.id),
		onToggleComplete: () => onToggleComplete(reminder.id, reminder.completed),
	});

	return (
		<div
			ref={wrapperRef}
			className="sidebar-reminder-card-wrapper"
			style={{ cursor: 'pointer' }}
			role="group"
			tabIndex={0}
			aria-label={`${reminder.content}. Press Enter to edit reminder.`}
		>
			<SharedReminderCard
				listStyle={listStyle}
				colorScheme={colorScheme}
				reminder={reminder}
				completionPreview={completionPreview}
				animationConfig={{ enabled: false }}
				index={index}
				hideProject={hideProject}
			/>
		</div>
	);
});
