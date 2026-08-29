import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ReminderCard as SharedReminderCard } from '@/reminders/components/ReminderCard';
import { useReminderCardInteractions } from '@/reminders/components/useReminderCardInteractions';
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
	onToggleComplete: (id: string, completed: boolean) => void | Promise<void>;
}) {
	const mountedRef = useRef(true);
	const isCompletingRef = useRef(false);
	const [completionPreview, setCompletionPreview] = useState(false);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (!reminder.completed) return;
		isCompletingRef.current = false;
		setCompletionPreview(false);
	}, [reminder.completed]);

	const toggleComplete = useCallback(() => {
		if (isCompletingRef.current) return;
		if (reminder.completed) {
			void onToggleComplete(reminder.id, true);
			return;
		}

		isCompletingRef.current = true;
		setCompletionPreview(true);
		void Promise.resolve(onToggleComplete(reminder.id, false))
			.finally(() => {
				isCompletingRef.current = false;
				if (mountedRef.current) setCompletionPreview(false);
			});
	}, [onToggleComplete, reminder.completed, reminder.id]);

	const wrapperRef = useReminderCardInteractions({
		onEdit: () => onEdit(reminder.id),
		onToggleComplete: toggleComplete,
		isDisabled: () => isCompletingRef.current,
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
				reminder={reminder}
				completionPreview={completionPreview}
				animationConfig={{ enabled: false }}
				index={index}
				hideProject={hideProject}
			/>
		</div>
	);
}
