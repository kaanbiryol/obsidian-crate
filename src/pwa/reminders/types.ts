import type { InferOutput } from 'valibot';
import type { reminderDraftSchema, reminderRecordSchema } from './cache/reminder-storage-validation';
import type { RecurrenceRule } from '@/reminders/types/reminder';

export type ModalMode = 'create' | 'edit';
export type ModalPickerId = 'date' | 'project' | 'recurrence';
export type LoadReminders = (options?: { silent?: boolean; maxAgeMs?: number }) => Promise<void>;

export type ReminderRecord = InferOutput<typeof reminderRecordSchema>;

export type ModalDraft = InferOutput<typeof reminderDraftSchema>;

export interface ModalState {
	mode: ModalMode;
	recovery?: boolean;
	reminderId?: string;
	expectedRevision?: string;
	operationId?: string;
	filePath?: string;
	draft: ModalDraft;
}

export interface PushState {
	phase: 'checking' | 'off' | 'enabled' | 'paused' | 'error' | 'blocked' | 'unsupported' | 'install';
	status: string | null;
}

export interface CachedReminderSnapshot {
	folderPath: string;
	reminders: ReminderRecord[];
	projects: string[];
	savedAt: number;
	etag?: string;
	/** Server changelog position for requesting only notes changed since this snapshot. */
	deltaBase?: string;
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
