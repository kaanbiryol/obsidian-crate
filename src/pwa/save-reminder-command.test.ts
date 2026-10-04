import { expect, it, vi } from 'vitest';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { createSaveReminderChange } from './save-reminder-command';
import type { ModalState } from './types';

vi.mock('./server-compatibility', () => ({ requireCompatibleServer: async () => ({ reminderOperationDay: 20_000 }) }));

it.each(['create', 'edit'] as const)('builds a durable %s command and snapshots its draft', async mode => {
	const modal: ModalState = { mode, operationId: crypto.randomUUID(), reminderId: mode === 'edit' ? 'existing' : undefined,
		filePath: mode === 'edit' ? 'Reminders/Inbox.md' : undefined,
		expectedRevision: mode === 'edit' ? 'revision' : undefined,
		draft: { content: 'Task', description: 'Details', project: 'Inbox', defaultProject: 'Inbox',
			priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } };
	const change = await createSaveReminderChange(modal, { folderPath: 'Reminders', upcomingDays: 7, allDayNotificationTime: null }, ['Inbox'], null);
	expect(reminderOperationDay(change.operationId)).toBe(20_000);
	expect(change.path).toBe(mode === 'create' ? '/reminders/create' : '/reminders/update');
	expect(JSON.parse(change.body)).toMatchObject({ content: 'Task', operationId: change.operationId,
		id: mode === 'create' ? change.operationId : 'existing', folderPath: 'Reminders' });
	modal.draft.content = 'Later edit';
	expect(change.modal?.draft.content).toBe('Task');
});
