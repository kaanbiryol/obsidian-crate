import type { ModalState, ReminderMutationBody, ReminderRecord } from './types';

export interface PendingReminderChange {
	operationId: string;
	kind: 'save' | 'complete' | 'delete' | 'reorder';
	recordId?: string;
	optimistic?: ReminderRecord;
	previous?: ReminderRecord;
	project?: string;
	orderedIds?: string[];
	modal?: ModalState;
	status: 'pending' | 'uncertain' | 'failed';
	error?: string;
	path: string;
	method: 'POST' | 'DELETE';
	body: string;
	attempts: number;
	retryAt: number;
	ambiguous?: boolean;
	reviewRequired?: boolean;
	followUp?: { operationId: string; input: ReminderMutationBody };
}

export interface ReminderChangeResult {
	reminder?: ReminderRecord;
	notificationWarning?: string;
}
