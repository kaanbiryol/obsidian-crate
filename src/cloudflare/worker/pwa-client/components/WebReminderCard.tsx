import React, { useCallback, useEffect, useRef, useState } from 'react';
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
	onToggleComplete: (id: string, completed: boolean) => void | Promise<void>;
}) {
	const wrapperRef = useRef<HTMLDivElement | null>(null);
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

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;

		const handleClick = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			if (isCompletingRef.current) {
				event.stopPropagation();
				return;
			}
			if (target.closest('.reorder-drag-handle')) {
				event.stopPropagation();
				return;
			}

			if (target.closest('.premium-checkbox') || target.closest('[role="checkbox"]')) {
				event.stopPropagation();
				toggleComplete();
				return;
			}

			if (target.closest('a[data-markdown-link]')) {
				event.stopPropagation();
				return;
			}

			onEdit(reminder.id);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (isCompletingRef.current) return;
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
	}, [onEdit, reminder.id, toggleComplete]);

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
