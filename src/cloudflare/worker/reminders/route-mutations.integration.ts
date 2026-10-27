/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { reminderRevision } from '@/reminders/core/reminderRevision';
import { handleCreateReminder } from './routes/create';
import { handleDeleteReminder, handleUpdateReminder } from './routes/existing-reminder';
import { handleListReminders } from './routes/list';
import { handleReorderReminders } from './routes/reorder';
import { scanReminderMarkdownContent } from '@/reminders/core/markdownScan';
import { ReminderFileSizeError } from './limits';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';

const { DB: db, BUCKET: bucket } = env;
beforeEach(async () => {
	await applySchema(db);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function seed(files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) await writeCommittedMarkdownFile(bucket, db, path, content, null);
}
async function read(path: string) {
	return (await readCommittedMarkdownFileVersion(bucket, db, path))?.content ?? null;
}
/** A web app request body, with the identity, revision and order observed now. */
async function request(route: string, fields: Record<string, unknown>, method = 'POST') {
	const path = typeof fields.filePath === 'string' ? fields.filePath : `Reminders/${typeof fields.project === 'string' ? fields.project : 'Inbox'}.md`;
	const reminders = scanReminderMarkdownContent(path, await read(path) ?? '', 'Reminders').reminders;
	const reminder = reminders.find(item => item.id === fields.id);
	const operationId = createReminderOperationId(Math.floor(Date.now() / 86_400_000));
	return new Request(`https://worker.test/reminders/${route}`, { method, headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ operationId, id: fields.id ?? operationId, expectedRevision: reminder ? await reminderRevision(reminder) : undefined,
			expectedOrder: reminders.map(item => item.id), folderPath: 'Reminders', ...fields }) });
}
function list() {
	return handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders'), env);
}
const existing = { 'Reminders/Inbox.md': '# Inbox\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n' };

describe('reminder route mutations with D1 and R2', () => {
	it('updates the parsed cache eagerly after a reminder mutation', async () => {
		await seed(existing);
		const body = await request('update', { id: 'r-existing', filePath: 'Reminders/Inbox.md', content: 'Updated task' });
		const bucketGet = vi.spyOn(bucket, 'get');

		const update = await handleUpdateReminder(body, env);
		expect(update.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(1);

		const listing = await list();
		expect((await listing.json() as { reminders: Array<{ content: string }> }).reminders.map(reminder => reminder.content)).toEqual(['Updated task']);
		expect(bucketGet).toHaveBeenCalledTimes(1);
	});

	it('updates a known source file without scanning unrelated project files', async () => {
		await seed({
			...existing,
			'Reminders/Work.md': '# Work\n\n- [ ] Work task <!-- crate-id:r-work -->\n',
			'Reminders/Home.md': '# Home\n\n- [ ] Home task <!-- crate-id:r-home -->\n',
		});
		const body = await request('update', { id: 'r-existing', filePath: 'Reminders/Inbox.md', content: 'Updated task' });
		const bucketGet = vi.spyOn(bucket, 'get');

		const response = await handleUpdateReminder(body, env);

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(1);
		expect(await read('Reminders/Inbox.md')).toContain('Updated task');
		expect((await response.json() as { reminder?: unknown }).reminder).toMatchObject({
			id: 'r-existing', content: 'Updated task', filePath: 'Reminders/Inbox.md',
		});
	});

	it('requires a source file path for reminder mutations', async () => {
		await seed(existing);
		const body = await request('update', { id: 'r-existing', content: 'Updated task' });
		const bucketGet = vi.spyOn(bucket, 'get');

		const response = await handleUpdateReminder(body, env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Valid filePath required' });
		expect(bucketGet).not.toHaveBeenCalled();
	});

	it('creates and deletes reminders against the source markdown files', async () => {
		await seed({ 'Reminders/Inbox.md': '# Inbox\n\n' });
		const idFromName = vi.spyOn(env.REMINDER_ALARMS, 'idFromName');

		const create = await handleCreateReminder(await request('create', { content: 'Check article', project: 'Inbox', dueDatetime: '2099-01-10T10:00:00.000Z' }), env);
		expect(create.status).toBe(200);
		expect(await read('Reminders/Inbox.md')).toContain('Check article');
		// The request coordinator owns wake-ups; file handlers only commit their outbox work.
		expect(idFromName).not.toHaveBeenCalled();

		const listing = await list();
		const createdId = (await listing.json() as { reminders: Array<{ id: string }> }).reminders[0]?.id;
		expect(createdId).toBeTruthy();

		const deletion = await handleDeleteReminder(await request('delete', { id: createdId, filePath: 'Reminders/Inbox.md' }, 'DELETE'), env);
		expect(deletion.status).toBe(200);
		expect(await read('Reminders/Inbox.md')).not.toContain('Check article');
		expect(await db.prepare('SELECT COUNT(*) AS count FROM scheduled_reminders').first()).toEqual({ count: 0 });
	});

	it('rejects unsafe project paths', async () => {
		await seed({ 'Reminders/Inbox.md': '# Inbox\n\n' });

		const response = await handleCreateReminder(await request('create', { content: 'Escape folder', project: '../Secrets' }), env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Invalid project' });
		expect(await db.prepare('SELECT COUNT(*) AS count FROM files WHERE path LIKE ?').bind('%Secrets%').first()).toEqual({ count: 0 });
	});

	it('persists recurrence from create and update payloads', async () => {
		await seed(existing);

		const create = await handleCreateReminder(await request('create', { content: 'Recurring create', project: 'Inbox',
			recurrence: { frequency: 'daily', hour: 9, minute: 0 } }), env);
		expect(create.status).toBe(200);
		expect(await read('Reminders/Inbox.md')).toContain('Recurring create daily 09:00');

		const added = await handleUpdateReminder(await request('update', { id: 'r-existing', filePath: 'Reminders/Inbox.md',
			recurrence: { frequency: 'weekly', daysOfWeek: [1, 3], hour: 10, minute: 30 } }), env);
		expect(added.status).toBe(200);
		expect(await read('Reminders/Inbox.md')).toContain('Existing task every Mon, Wed 10:30');

		const removed = await handleUpdateReminder(await request('update', { id: 'r-existing', filePath: 'Reminders/Inbox.md', recurrence: null }), env);
		expect(removed.status).toBe(200);
		const content = await read('Reminders/Inbox.md');
		expect(content).toContain('Existing task');
		expect(content).toContain('<!-- crate-id:r-existing -->');
		expect(content).not.toContain('every Mon, Wed 10:30');
	});

	it('reorders active reminders while leaving completed reminders at the bottom', async () => {
		await seed({ 'Reminders/Inbox.md': '# Inbox\n\n- [ ] First <!-- crate-id:r1 -->\n- [ ] Second <!-- crate-id:r2 -->\n- [x] Done <!-- crate-id:r3 -->\n' });

		const response = await handleReorderReminders(await request('reorder', { project: 'Inbox', orderedIds: ['r2', 'r1'] }), env);

		expect(response.status).toBe(200);
		expect(await read('Reminders/Inbox.md')).toContain('- [ ] Second <!-- crate-id:r2 -->\n- [ ] First <!-- crate-id:r1 -->\n- [x] Done <!-- crate-id:r3 -->');
	});

	it('refuses deletes and reorders in a note the list reports as too large', async () => {
		const path = 'Reminders/Inbox.md';
		const content = `# Inbox\n\n${'x'.repeat(1024 * 1024)}\n\n- [ ] First <!-- crate-id:r-big-1 -->\n- [ ] Second <!-- crate-id:r-big-2 -->\n`;
		await seed({ [path]: content });
		const listed = async () => await (await list()).json() as { reminders: unknown[]; issues: Array<{ path: string }> };
		const before = await listed();
		expect(before).toMatchObject({ reminders: [], issues: [{ path }] });

		await expect(handleDeleteReminder(await request('delete', { id: 'r-big-1', filePath: path }, 'DELETE'), env)).rejects.toBeInstanceOf(ReminderFileSizeError);
		await expect(handleReorderReminders(await request('reorder', { project: 'Inbox', orderedIds: ['r-big-2', 'r-big-1'] }), env)).rejects.toBeInstanceOf(ReminderFileSizeError);

		expect(await read(path)).toBe(content);
		expect(await listed()).toEqual(before);
	});
});
