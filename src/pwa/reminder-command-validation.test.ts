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
const modal = { mode: 'create', draft, pendingSave: { path: '/reminders/create', body: JSON.stringify(body), input, draftKey: 'key' } };
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

	it('retains legacy acceptance, extra fields, request formatting, and recurrence metadata', () => {
		const recurrence = { frequency: 'weekly', daysOfWeek: [5, 1, 5], extra: 'keep' };
		const value = { ...save, status: ['pending'], path: ['/reminders/create'], extra: { keep: true },
			body: JSON.stringify(body, null, 2), optimistic: { ...record, recurrence },
			modal: { mode: ['create'], draft, pendingSave: { legacy: 'unvalidated by outbox' } },
			// Outbox follow-ups historically require only these three input fields.
			followUp: { operationId: 'another_123456789', input: { folderPath, content: 'Later edit', project: 'Inbox' } } };
		const before = structuredClone(value);
		expect(validChange(value)).toBe(true);
		expect(value).toEqual(before);
		expect(value.optimistic.recurrence).toBe(recurrence);
		expect(validChange({ ...save, reviewRequired: true, status: 'failed', ambiguous: true })).toBe(true);
		expect(validChange({ ...save, reviewRequired: true, status: ['failed'], ambiguous: true })).toBe(false);
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

	it('preserves retained modal attempts without normalizing or rewriting them', () => {
		for (const recurrence of [undefined, null, { frequency: 'weekly', daysOfWeek: [5, 1, 5] }]) {
			const value = { ...modal, mode: ['create'], extra: 'keep', pendingSave: { ...modal.pendingSave,
				path: ['/reminders/create'], body: JSON.stringify(body, null, 2), input: { ...input, recurrence } } };
			const before = structuredClone(value);
			expect(validModal(value)).toBe(true);
			expect(value).toEqual(before);
		}
	});

	it.each([
		{ path: '/other' }, { body: '{broken' }, { draftKey: null }, { input: { ...input, priority: 2 } },
		{ input: { ...input, dueDate: undefined } }, { input: { ...input, folderPath: 'Private' } },
		{ input: { ...input, recurrence: { frequency: 'invalid' } } },
		{ body: JSON.stringify({ ...body, filePath: 'Reminders/../Private.md' }) },
		{ body: JSON.stringify({ ...body, folderPath: 'Private' }) }, { body: JSON.stringify({ ...body, id: '' }) },
	])('rejects damaged retained attempts (%j)', patch => {
		expect(validModal({ ...modal, pendingSave: { ...modal.pendingSave, ...patch } })).toBe(false);
	});

	it('rejects arrays masquerading as commands, modals or nested objects', () => {
		expect(validChange(Object.assign([], save))).toBe(false);
		expect(validModal(Object.assign([], modal))).toBe(false);
		expect(validModal({ ...modal, pendingSave: Object.assign([], modal.pendingSave) })).toBe(false);
		expect(validModal({ ...modal, pendingSave: { ...modal.pendingSave, input: Object.assign([], input) } })).toBe(false);
		expect(validChange({ ...save, modal: Object.assign([], { mode: 'create', draft }) })).toBe(false);
	});
});
