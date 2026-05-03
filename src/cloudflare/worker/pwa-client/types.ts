import type { RecurrenceRule } from '@/reminders/types/reminder';

export type ModalMode = 'create' | 'edit';
export type ModalPickerId = 'date' | 'project' | 'recurrence';
export type ToastKind = 'success' | 'error' | 'info';
export type StartTab = 'inbox' | 'today' | 'upcoming' | 'browse';
export type DataMode = 'live' | 'cached' | 'error';

export interface ReminderRecord {
	id: string;
	content: string;
	description?: string;
	dueDate?: string;
	dueDatetime?: string;
	priority: 1 | 4;
	completed: boolean;
	project: string;
	recurrence?: RecurrenceRule;
	filePath: string;
	lineNumber?: number;
	createdAt?: string;
	updatedAt?: string;
}

export interface StoredConfig {
	folderPath: string;
	upcomingDays: number;
	allDayNotificationTime: string | null;
}

export interface ModalDraft {
	content: string;
	description: string;
	project: string;
	defaultProject: string;
	priority: ReminderRecord['priority'];
	dueDate: string;
	dueTime: string;
	recurrence?: RecurrenceRule;
	activePicker: ModalPickerId | null;
	deleteConfirm: boolean;
}

export interface ModalState {
	mode: ModalMode;
	reminderId?: string;
	draft: ModalDraft;
}

export interface ToastState {
	kind: ToastKind;
	message: string;
}

export interface PushState {
	supported: boolean;
	subscribed: boolean;
	status: string | null;
}

export interface CachedReminderSnapshot {
	folderPath: string;
	reminders: ReminderRecord[];
	projects: string[];
	savedAt: number;
}

export interface ReminderMutationBody {
	folderPath: string;
	allDayNotificationTime: string | null;
	content: string;
	description: string | null;
	project: string;
	priority: ReminderRecord['priority'];
	dueDate: string | null;
	dueDatetime: string | null;
	recurrence?: RecurrenceRule | null;
}

export interface PullRefreshState {
	distance: number;
	progress: number;
	ready: boolean;
	refreshing: boolean;
}
