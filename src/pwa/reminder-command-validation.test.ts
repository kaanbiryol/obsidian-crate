import { describe, expect, it } from 'vitest';
import { isStoredReminderModal } from './reminder-draft-validation';
import { isStoredReminderChange } from './reminder-outbox-validation';

const operationId = 'operation_123456789';
const folderPath = 'Reminders';
const draft = { content: 'Task', description: '', project: 'Inbox', defaultProject: 'Inbox', dueDate: '', dueTime: '',
	priority: 4, activePicker: null, deleteConfirm: false };
const record = { id: 'one', content: 'Task', project: 'Inbox', priority: 4, completed: false, filePath: 'Reminders/Inbox.md' };
const body = { operationId, folderPath, id: 'one', content: 'Task', project: 'Inbox' };
const input = { folderPath, content: 'Task', project: 'Inbox', priority: 4, description: null, dueDate: null, dueDatetime: null };
const save = { operationId, kind: 'save', recordId: 'one', status: 'pending', attempts: 0, retryAt: 0,
	method: 'POST', path: '/reminders/create', body: JSON.stringify(body) };
const modal = { mode: 'create', draft };
const validChange = (value: unknown) => isStoredReminderChange(value, operationId, folderPath);
const validModal = (value: unknown) => isStoredReminderModal(value, folderPath);

describe('stored command schema compatibility', () => {
	it.each([
		save,
		{ ...save, path: '/reminders/update' },
		{ ...save, kind: 'complete', path: '/reminders/set-completed', body: JSON.stringify({ ...body, completed: false }) },
		{ ...save, kind: 'delete', method: 'DELETE', path: '/reminders/delete' },
		{ ...save, kind: 'reorder', path: '/reminders/reorder', project: 'Inbox', orderedIds: ['two', 'one'],
			body: JSON.stringify({ operationId, folderPath, project: 'Inbox', orderedIds: ['two', 'one'], expectedOrder: ['one', 'two'] }) },
	])('accepts each command shape: $kind $path', value => {
		expect(validChange(value)).toBe(true);
	});

	it.each([
		{ kind: 'unknown' }, { method: 'DELETE' }, { path: '/auth/session' }, { recordId: '' },
		{ operationId: 'different_123456789' }, { status: 'unknown' }, { attempts: -1 }, { attempts: 0.5 },
		{ attempts: Number.MAX_SAFE_INTEGER + 1 }, { retryAt: Infinity }, { retryAt: -1 }, { reviewRequired: true },
		{ reviewRequired: true, ambiguous: true }, { ambiguous: 'yes' }, { error: null },
		{ body: '{broken' }, { body: JSON.stringify({ ...body, folderPath: 'Private' }) },
		{ body: JSON.stringify({ ...body, id: 'other' }) }, { body: JSON.stringify({ ...body, operationId: 'other' }) },
		{ body: JSON.stringify({ ...body, content: null }) },
		{ optimistic: { ...record, id: 'other' } }, { previous: { ...record, filePath: 'Private/Inbox.md' } },
		{ modal: { mode: 'view', draft } }, { modal: { mode: 'create', draft: { ...draft, content: null } } },
		{ followUp: { operationId, input } }, { followUp: { operationId: 'another_123456789', input: { ...input, folderPath: 'Private' } } },
	])('rejects unsafe command metadata (%j)', patch => {
		expect(validChange({ ...save, ...patch })).toBe(false);
	});

	it('preserves extra fields, request bytes and recurrence metadata', () => {
		const recurrence = { frequency: 'weekly', daysOfWeek: [5, 1, 5], extra: 'keep' };
		const value = { ...save, extra: { keep: true }, body: JSON.stringify(body, null, 2),
			optimistic: { ...record, recurrence }, modal };
		const before = structuredClone(value);
		expect(validChange(value)).toBe(true);
		expect(value).toEqual(before);
		for (const patch of [{ status: ['pending'] }, { path: ['/reminders/create'] }, { modal: { ...modal, mode: ['create'] } }]) {
			expect(validChange({ ...save, ...patch })).toBe(false);
		}
	});

	it('checks reorder agreement and excludes follow-ups from other commands', () => {
		const reorder = { ...save, kind: 'reorder', path: '/reminders/reorder', project: 'Inbox', orderedIds: ['one'],
			body: JSON.stringify({ operationId, folderPath, project: 'Inbox', orderedIds: ['one'], expectedOrder: [] }) };
		expect(validChange(reorder)).toBe(true);
		for (const patch of [{ orderedIds: ['other'] }, { expectedOrder: null }, { project: 'Other' }]) {
			expect(validChange({ ...reorder, body: JSON.stringify({ ...JSON.parse(reorder.body), ...patch }) })).toBe(false);
		}
		expect(validChange({ ...reorder, followUp: { operationId: 'another_123456789', input } })).toBe(false);
	});

	it('rejects obsolete retained attempts instead of resending them', () => {
		expect(validModal({ ...modal, pendingSave: { path: '/reminders/create', body: JSON.stringify(body), input, draftKey: 'key' } })).toBe(false);
		expect(validModal({ ...modal, mode: ['create'] })).toBe(false);
		expect(validModal(modal)).toBe(true);
	});

	it('rejects arrays masquerading as commands, modals or nested objects', () => {
		expect(validChange(Object.assign([], save))).toBe(false);
		expect(validModal(Object.assign([], modal))).toBe(false);
		expect(validChange({ ...save, modal: Object.assign([], { mode: 'create', draft }) })).toBe(false);
	});
});
