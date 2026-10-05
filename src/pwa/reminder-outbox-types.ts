import type { ModalState, ReminderRecord } from './types';

interface ReminderChangeState {
	operationId: string;
	optimistic?: ReminderRecord;
	previous?: ReminderRecord;
	modal?: ModalState;
	status: 'pending' | 'uncertain' | 'failed';
	error?: string;
	body: string;
	attempts: number;
	retryAt: number;
	ambiguous?: boolean;
	reviewRequired?: boolean;
}

interface ReminderRecordChange extends ReminderChangeState {
	recordId: string;
	project?: never;
	orderedIds?: never;
}

export type PendingReminderChange =
	| (ReminderRecordChange & { kind: 'save'; method: 'POST'; path: '/reminders/create' | '/reminders/update' })
	| (ReminderRecordChange & { kind: 'complete'; method: 'POST'; path: '/reminders/set-completed' })
	| (ReminderRecordChange & { kind: 'delete'; method: 'DELETE'; path: '/reminders/delete' })
	| (ReminderChangeState & { kind: 'reorder'; method: 'POST'; path: '/reminders/reorder';
		project: string; orderedIds: string[]; recordId?: never });

export interface ReminderChangeResult {
	reminder?: ReminderRecord;
	notificationWarning?: string;
}
