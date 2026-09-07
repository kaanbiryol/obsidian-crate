import type { RecurrenceRule } from '@/reminders/types/reminder';

export type ModalMode = 'create' | 'edit';
export type ModalPickerId = 'date' | 'project' | 'recurrence';
export type ToastKind = 'success' | 'error' | 'info';
export type StartTab = 'inbox' | 'today' | 'upcoming' | 'browse';
export type DataMode = 'live' | 'cached' | 'error';
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type LoadReminders = (options?: { silent?: boolean; maxAgeMs?: number }) => Promise<void>;
export type ShowToast = (kind: ToastKind, message: string) => void;

export interface ReminderRecord {
	id: string;
	revision?: string;
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
}

export interface StoredConfig {
	folderPath: string;
	upcomingDays: number;
	allDayNotificationTime: string | null;
}

export interface ModalDraft {
  originalDueDatetime?: string;
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
	recovery?: boolean;
	reminderId?: string;
	expectedRevision?: string;
	operationId?: string;
	pendingSave?: {
		path: string;
		body: string;
		input: ReminderMutationBody;
		draftKey: string;
	};
	filePath?: string;
	draft: ModalDraft;
}

export interface ToastState {
	kind: ToastKind;
	message: string;
}

export interface PushState {
	phase: 'checking' | 'off' | 'enabled' | 'error' | 'blocked' | 'unsupported' | 'install';
	status: string | null;
}

export interface CachedReminderSnapshot {
	folderPath: string;
	reminders: ReminderRecord[];
	projects: string[];
	savedAt: number;
	etag?: string;
}

export interface ReminderMutationBody {
	folderPath: string;
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
