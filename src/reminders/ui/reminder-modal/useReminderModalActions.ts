import { useCallback, useMemo, useState } from 'react';
import type { Priority, Reminder, RecurrenceRule } from '../../types';
import { createLogger } from '../../utils/logger';
import { buildDeleteConfirmationMessage } from './deleteConfirmation';
import {
	buildReminderSubmission,
	executeReminderAction,
} from './reminderMutation';

const log = createLogger('AddReminderModal');

interface UseReminderModalActionsOptions {
	content: string;
	description: string;
	projects: string[];
	priority: Priority;
	project: string;
	dueDate: string | null;
	hasTime?: boolean;
	recurrence?: RecurrenceRule;
	reminder?: Reminder;
	optimistic: boolean;
	onClose: () => void;
	onAdd?: (content: string, project: string, priority: number, dueDate?: string, recurrence?: RecurrenceRule, hasTime?: boolean, description?: string) => Promise<void>;
	onSave?: (reminder: Reminder) => Promise<void>;
	onDelete?: (reminder: Reminder) => Promise<void>;
	onError?: (error: Error) => void;
}

export function useReminderModalActions({
	content,
	description,
	projects,
	priority,
	project,
	dueDate,
	hasTime,
	recurrence,
	reminder,
	optimistic,
	onClose,
	onAdd,
	onSave,
	onDelete,
	onError,
}: UseReminderModalActionsOptions) {
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const isEditing = !!reminder;

	const handleSubmit = useCallback(async () => {
		const submission = buildReminderSubmission({
			content,
			description,
			projects,
			priority,
			project,
			dueDate,
			hasTime,
			recurrence,
			reminder,
		});
		if (!submission) return;

		await executeReminderAction({
			optimistic,
			close: onClose,
			delayMs: 300,
			action: async () => {
				if (submission.updatedReminder && onSave) {
					await onSave(submission.updatedReminder);
				} else if (onAdd) {
					await onAdd(
						submission.content,
						submission.project,
						submission.priority,
						submission.dueDate,
						submission.recurrence,
						submission.hasTime,
						submission.description,
					);
				}
			},
			onError: (error) => {
				log.error(`Failed to ${isEditing ? 'update' : 'add'} reminder:`, error);
				onError?.(error);
			},
		});
	}, [
		content,
		description,
		dueDate,
		hasTime,
		isEditing,
		onAdd,
		onClose,
		onError,
		onSave,
		optimistic,
		priority,
		project,
		projects,
		recurrence,
		reminder,
	]);

	const handleDeleteClick = useCallback(() => {
		setShowDeleteConfirm(true);
	}, []);

	const handleDeleteConfirm = useCallback(async () => {
		if (!onDelete || !reminder) return;

		await executeReminderAction({
			optimistic,
			close: onClose,
			beforeClose: optimistic ? () => setShowDeleteConfirm(false) : undefined,
			beforeRun: optimistic ? undefined : () => setIsDeleting(true),
			afterSuccess: optimistic ? undefined : () => setShowDeleteConfirm(false),
			afterSettled: optimistic ? undefined : () => setIsDeleting(false),
			action: async () => {
				await onDelete(reminder);
			},
			onError: (error) => {
				log.error('Failed to delete reminder:', error);
				onError?.(error);
			},
		});
	}, [onClose, onDelete, onError, optimistic, reminder]);

	const deleteMessage = useMemo(
		() => buildDeleteConfirmationMessage(reminder),
		[reminder],
	);

	return {
		showDeleteConfirm,
		isDeleting,
		deleteMessage,
		handleSubmit,
		handleDeleteClick,
		handleDeleteConfirm,
		closeDeleteConfirm: () => setShowDeleteConfirm(false),
	};
}
