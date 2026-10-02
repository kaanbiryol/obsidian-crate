import { expect, it } from 'vitest';
import { applyReminderFileCommand, reminderCommandPayload } from './reminderFileCommand';
import { scanReminderMarkdownContent } from './markdownScan';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { appendCreatedReminderBlock, buildCreatedReminderBlock } from './markdownReminderMutation';

const folder = 'Reminders', path = 'Reminders/Inbox.md';
const op = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const note = '# Notes\n\nPrivate prose before\n\n- [ ] Buy bread @2099-01-02 <!-- crate-id:r1 -->\n\nUnrelated paragraph after\n';
async function request(content = note) {
	const reminder = await reminderCommandPayload(scanReminderMarkdownContent(path, content, folder).reminders[0]!);
	return { folderPath: folder, operationId: op(), id: reminder.id, filePath: path, expectedRevision: reminder.revision };
}

it('updates reminder content without replacing surrounding Markdown', async () => {
	const result = await applyReminderFileCommand('update', { ...await request(), content: 'Buy milk' }, folder, async () => note);
	expect(result.files).toHaveLength(1);
	expect(result.files[0]!.content).toContain('Private prose before');
	expect(result.files[0]!.content).toContain('Unrelated paragraph after');
	expect(result.response).toMatchObject({ reminder: { content: 'Buy milk' } });
});

it('moves a reminder with two conditional file replacements and preserves both notes', async () => {
	const result = await applyReminderFileCommand('update', { ...await request(), project: 'Work' }, folder, async name => name === path ? note : '# Work\n\nOther project prose\n');
	expect(result.files.map(file => file.path)).toEqual([path, 'Reminders/Work.md']);
	expect(result.files[0]!.content).not.toContain('crate-id:r1');
	expect(result.files[0]!.content).toContain('Unrelated paragraph after');
	expect(result.files[1]!.content).toContain('Other project prose');
	expect(result.response).toMatchObject({ reminder: { filePath: 'Reminders/Work.md' } });
});

it('rejects stale reminder revisions and scope traversal before editing', async () => {
	const body = await request();
	await expect(applyReminderFileCommand('update', { ...body, content: 'Stale' }, folder, async () => note.replace('Buy bread', 'Already changed'))).rejects.toThrow('changed on another device');
	await expect(applyReminderFileCommand('delete', { ...body, filePath: 'Reminders/../Secret.md' }, folder, async () => note)).rejects.toThrow('outside');
});

it('creates with a stable identity and guards reorder against concurrent additions', async () => {
	const operationId = op();
	const result = await applyReminderFileCommand('create', { folderPath: folder, operationId, id: operationId, content: 'New', project: 'Inbox', dueDate: '2099-01-03' }, folder, async () => note);
	expect(result.createdId).toBe(operationId);
	expect(result.response).toMatchObject({ reminder: { id: operationId } });
	await expect(applyReminderFileCommand('reorder', { expectedOrder: ['r1'], orderedIds: ['r1'], project: 'Inbox' }, folder, async () => result.files[0]!.content)).rejects.toThrow('order changed');
});

it('advances recurring completion once, stops at its count, and reopens the final occurrence', async () => {
	const recurring = buildCreatedReminderBlock({ content: 'Daily task', reminderId: 'r1', priority: 4,
		dueDate: new Date('2099-01-01T09:00:00Z'), hasTime: true,
		recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0, count: 2 } }).checkboxLine;
	let content = `# Private notes\n\n${recurring}\n\nKeep this paragraph\n`;
	const complete = async (completed: boolean) => {
		const result = await applyReminderFileCommand('set-completed', { ...await request(content), completed }, folder, async () => content);
		content = result.files[0]!.content;
		if (!('reminder' in result.response)) throw new Error('Missing saved reminder');
		return result.response.reminder;
	};
	expect(await complete(true)).toMatchObject({ completed: false, dueDatetime: '2099-01-02T09:00:00.000Z', recurrence: { completedCount: 1 } });
	expect(await complete(true)).toMatchObject({ completed: true, dueDatetime: '2099-01-02T09:00:00.000Z', recurrence: { completedCount: 2 } });
	const finalOccurrence = content;
	await complete(true);
	expect(content).toBe(finalOccurrence);
	expect(await complete(false)).toMatchObject({ completed: false, dueDatetime: '2099-01-02T09:00:00.000Z', recurrence: { completedCount: 1 } });
	await complete(true);
	expect(content).toBe(finalOccurrence);
	expect(content).toContain('Keep this paragraph');
});

it.each([false, true])('keeps omitted fields but explicitly clears dates, recurrence and description during an edit (move=%s)', async move => {
	const block = buildCreatedReminderBlock({ content: 'Task', description: 'Private description', reminderId: 'r1', priority: 1,
		dueDate: new Date('2099-01-01T09:00:00Z'), hasTime: true,
		recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0, count: 2 } });
	const content = appendCreatedReminderBlock('# Private notes\n', block);
	const before = await applyReminderFileCommand('update', { ...await request(content), content: 'Renamed' }, folder, async () => content);
	expect(before.response).toMatchObject({ reminder: { description: 'Private description', dueDatetime: '2099-01-01T09:00:00.000Z', recurrence: { count: 2 } } });
	const after = await applyReminderFileCommand('update', { ...await request(content), dueDate: null, dueDatetime: null, description: null, recurrence: null,
		...(move ? { project: 'Work' } : {}) }, folder, async name => name === path ? content : null);
	if (!('reminder' in after.response)) throw new Error('Missing saved reminder');
	expect(after.response.reminder?.description).toBeUndefined();
	expect(after.response.reminder?.dueDate).toBeUndefined();
	expect(after.response.reminder?.dueDatetime).toBeUndefined();
	expect(after.response.reminder?.recurrence).toBeUndefined();
	expect(after.response.reminder?.filePath).toBe(move ? 'Reminders/Work.md' : path);
});
