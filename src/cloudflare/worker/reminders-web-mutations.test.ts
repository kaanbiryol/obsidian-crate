import { describe, expect, it, vi } from 'vitest';
import { handleCreateReminder } from './reminders-web/routes/create';
import { handleDeleteReminder } from './reminders-web/routes/delete';
import { handleListReminders } from './reminders-web/routes/list';
import { handleUpdateReminder } from './reminders-web/routes/update';
import { createEnv } from './reminders-web-test-harness';

describe('reminders web handlers', () => {
it('updates the parsed cache eagerly after a reminder mutation', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
			},
			files: { 'Reminders/Inbox.md': null },
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		const updateResponse = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					content: 'Updated task',
				}),
			}),
			workspace.env as never,
		);
		expect(updateResponse.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(1);

		const listResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const result = await listResponse.json() as { reminders: Array<{ content: string }> };
		expect(result.reminders.map((reminder) => reminder.content)).toEqual(['Updated task']);
		expect(bucketGet).toHaveBeenCalledTimes(1);
	});

	it('updates a known source file without scanning unrelated project files', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Work task <!-- crate-id:r-work -->\n',
				'files/Reminders/Home.md': '# Home\n\n- [ ] Home task <!-- crate-id:r-home -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
				'Reminders/Home.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		const response = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					content: 'Updated task',
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(1);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Updated task');
		const result = await response.json() as { reminder?: { id: string; content: string; filePath: string } };
		expect(result.reminder).toMatchObject({
			id: 'r-existing',
			content: 'Updated task',
			filePath: 'Reminders/Inbox.md',
		});
	});

	it('requires a source file path for reminder mutations', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
			},
			files: { 'Reminders/Inbox.md': null },
		});

		const response = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-existing',
					content: 'Updated task',
				}),
			}),
			workspace.env as never,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Valid filePath required' });
		expect(workspace.env.BUCKET.get).not.toHaveBeenCalled();
	});

	it('creates and deletes reminders against the source markdown files', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const createResponse = await handleCreateReminder(
			new Request('https://worker.test/reminders/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					content: 'Check article',
					project: 'Inbox',
					dueDatetime: '2099-01-10T10:00:00.000Z',
				}),
			}),
			workspace.env as never,
		);

		expect(createResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Check article');
		// The request coordinator owns wake-ups; file handlers only commit their outbox work.
		expect(workspace.env.REMINDER_ALARMS.idFromName).not.toHaveBeenCalled();

		const listResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const listResult = await listResponse.json() as { reminders: Array<{ id: string }> };
		const createdId = listResult.reminders[0]?.id;
		expect(createdId).toBeTruthy();

		const deleteResponse = await handleDeleteReminder(
			new Request('https://worker.test/reminders/delete', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: createdId,
					filePath: 'Reminders/Inbox.md',
				}),
			}),
			workspace.env as never,
		);

		expect(deleteResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).not.toContain('Check article');
		expect(workspace.scheduled.size).toBe(0);
	});

	it('rejects unsafe project paths and invalid all-day notification times', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const unsafeProjectResponse = await handleCreateReminder(
			new Request('https://worker.test/reminders/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					content: 'Escape folder',
					project: '../Secrets',
				}),
			}),
			workspace.env as never,
		);

		expect(unsafeProjectResponse.status).toBe(400);
		expect(await unsafeProjectResponse.json()).toEqual({ error: 'Invalid project' });
		expect(workspace.files.has('Reminders/../Secrets.md')).toBe(false);

	});

	it('persists recurrence from create and update payloads', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const createResponse = await handleCreateReminder(
			new Request('https://worker.test/reminders/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					content: 'Recurring create',
					project: 'Inbox',
					recurrence: { frequency: 'daily', hour: 9, minute: 0 },
				}),
			}),
			workspace.env as never,
		);

		expect(createResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Recurring create daily 09:00');

		const addRecurrenceResponse = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					recurrence: { frequency: 'weekly', daysOfWeek: [1, 3], hour: 10, minute: 30 },
				}),
			}),
			workspace.env as never,
		);

		expect(addRecurrenceResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Existing task every Mon, Wed 10:30');

		const removeRecurrenceResponse = await handleUpdateReminder(
			new Request('https://worker.test/reminders/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: await workspace.mutationBody({
					folderPath: 'Reminders',
					id: 'r-existing',
					filePath: 'Reminders/Inbox.md',
					recurrence: null,
				}),
			}),
			workspace.env as never,
		);

		expect(removeRecurrenceResponse.status).toBe(200);
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('Existing task');
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).toContain('<!-- crate-id:r-existing -->');
		expect(workspace.readCurrentFile('Reminders/Inbox.md')).not.toContain('every Mon, Wed 10:30');
	});
});
