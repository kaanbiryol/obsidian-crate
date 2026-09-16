import type { InferOutput } from 'valibot';
import type { reminderDraftSchema, reminderRecordSchema } from './reminder-storage-validation';
import type { RecurrenceRule } from '@/reminders/types/reminder';

export type ModalMode = 'create' | 'edit';
export type ModalPickerId = 'date' | 'project' | 'recurrence';
export type ToastKind = 'success' | 'error' | 'info';
export type StartTab = 'inbox' | 'today' | 'upcoming' | 'browse';
export type DataMode = 'live' | 'cached' | 'error';
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type LoadReminders = (options?: { silent?: boolean; maxAgeMs?: number }) => Promise<void>;
export type ShowToast = (kind: ToastKind, message: string) => void;

export type ReminderRecord = InferOutput<typeof reminderRecordSchema>;

export interface StoredConfig {
	folderPath: string;
	upcomingDays: number;
	allDayNotificationTime: string | null;
}

export type ModalDraft = InferOutput<typeof reminderDraftSchema>;

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
	issues?: ReminderSourceIssue[];
}

export interface ReminderSourceIssue {
	path: string;
	reason: string;
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
