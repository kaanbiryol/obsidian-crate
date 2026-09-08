import { isConfirmedReminder } from './reminder-change-request';
import { mergeReminderRecord } from './reminder-optimistic-state';
import { mergeProject, reorderProjectReminders } from './reminder-list-state';
import type { PendingReminderChange, ReminderChangeResult } from './reminder-outbox-types';
import type { ReminderRecord } from './types';

interface ReminderSettlement {
	version: 1;
	operationId: string;
	kind: PendingReminderChange['kind'];
	recordId?: string;
	previousRevision?: string;
	project?: string;
	orderedIds?: string[];
	expectedOrder?: string[];
	reminder?: ReminderRecord;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Uses the same storage-event ordering as removing an acknowledged command. */
export async function createReminderSettlementChannel(authToken: string, folderPath: string) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authToken));
	const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
	// Old clients ignore this reserved namespace, while their logout still erases it.
	const key = `crate-reminder-outbox:confirmed:${hash}:${encodeURIComponent(folderPath)}`;
	return {
		key,
		publish(change: PendingReminderChange, result: ReminderChangeResult) {
			const body = JSON.parse(change.body) as { expectedRevision?: string; expectedOrder?: string[] };
			const settlement: ReminderSettlement = { version: 1, operationId: change.operationId, kind: change.kind,
				recordId: change.recordId, previousRevision: body.expectedRevision, project: change.project,
				orderedIds: change.orderedIds, expectedOrder: body.expectedOrder, reminder: result.reminder };
			try {
				localStorage.setItem(key, JSON.stringify(settlement));
				localStorage.removeItem(key);
			} catch { throw new Error('Could not share the confirmed change with other tabs. Free up browser storage and retry.'); }
		},
		read(event: Pick<StorageEvent, 'key' | 'newValue'>): ReminderSettlement | null {
			if (event.key !== key || !event.newValue) return null;
			try {
				const value = JSON.parse(event.newValue) as Partial<ReminderSettlement> | null;
				if (!value || value.version !== 1 || typeof value.operationId !== 'string'
					|| !/^[a-zA-Z0-9_-]{16,128}$/.test(value.operationId)
					|| (value.previousRevision !== undefined && typeof value.previousRevision !== 'string')) return null;
				if (value.kind === 'reorder') {
					return typeof value.project === 'string' && strings(value.orderedIds) && strings(value.expectedOrder) ? value as ReminderSettlement : null;
				}
				if (typeof value.recordId !== 'string' || !value.recordId) return null;
				if (value.kind === 'delete') return value as ReminderSettlement;
				if ((value.kind !== 'save' && value.kind !== 'complete') || !isConfirmedReminder(value.reminder, value.recordId)
					|| !value.reminder.filePath.startsWith(`${folderPath}/`)) return null;
				return value as ReminderSettlement;
			} catch { return null; }
		},
	};
}

/** A delayed packet cannot replace a base revision already advanced by a newer read. */
export function applyReminderSettlement(reminders: ReminderRecord[], projects: string[], settled: ReminderSettlement) {
	if (settled.kind === 'reorder') {
		const currentOrder = reminders.filter(item => item.project === settled.project).map(item => item.id);
		if (JSON.stringify(currentOrder) !== JSON.stringify(settled.expectedOrder)) return null;
		return { reminders: reorderProjectReminders(reminders, settled.project!, settled.orderedIds!), projects };
	}
	const current = reminders.find(item => item.id === settled.recordId);
	if (current ? !settled.previousRevision || current.revision !== settled.previousRevision : settled.previousRevision) return null;
	if (settled.reminder) return { reminders: mergeReminderRecord(reminders, settled.reminder), projects: mergeProject(projects, settled.reminder.project) };
	if (settled.kind === 'delete') return { reminders: reminders.filter(item => item.id !== settled.recordId), projects };
	return null;
}
