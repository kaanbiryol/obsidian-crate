import React, { useEffect, useRef } from 'react';
import { ReminderCard as SharedReminderCard } from '@/reminders/components/ReminderCard';
import type { Reminder as SharedReminder } from '@/reminders/types/reminder';

export function WebReminderCard({
	reminder,
	index,
	hideProject,
	onEdit,
	onToggleComplete,
}: {
	reminder: SharedReminder;
	index: number;
	hideProject: boolean;
	onEdit: (id: string) => void;
	onToggleComplete: (id: string, completed: boolean) => void;
}) {
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;

		const handleClick = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('.reorder-drag-handle')) {
				event.stopPropagation();
				return;
			}

			if (target.closest('.premium-checkbox') || target.closest('[role="checkbox"]')) {
				event.stopPropagation();
				onToggleComplete(reminder.id, reminder.completed);
				return;
			}

			if (target.closest('a[data-markdown-link]')) {
				event.stopPropagation();
				return;
			}

			onEdit(reminder.id);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.target !== wrapper || (event.key !== 'Enter' && event.key !== ' ')) return;
			event.preventDefault();
			onEdit(reminder.id);
		};

		wrapper.addEventListener('click', handleClick, true);
		wrapper.addEventListener('keydown', handleKeyDown);
		return () => {
			wrapper.removeEventListener('click', handleClick, true);
			wrapper.removeEventListener('keydown', handleKeyDown);
		};
	}, [onEdit, onToggleComplete, reminder.completed, reminder.id]);

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
				reminder={reminder}
				animationConfig={{ enabled: false }}
				index={index}
				hideProject={hideProject}
			/>
		</div>
	);
}
