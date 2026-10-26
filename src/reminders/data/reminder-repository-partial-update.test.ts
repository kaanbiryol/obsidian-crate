import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderIndex } from './reminder-index';
import { createMarkdownWriter } from './markdown-writer';
import { createReminderRepository } from './reminder-repository';
import { toReminder } from './toReminder';
import { buildCreatedReminderBlock, appendCreatedReminderBlock } from '../core/markdownReminderMutation';
import type { UpdateReminderParams } from '../types/reminder';
import { ReminderInputError } from '../core/reminderMutationInput';

const path = 'Reminders/Inbox.md';
const rule = { frequency: 'daily' as const, timezone: 'Europe/Berlin', count: 5, completedCount: 1 };
const content = appendCreatedReminderBlock('# Inbox\n', buildCreatedReminderBlock({
	content: 'Original', description: 'Important details\nKeep both lines', dueDate: new Date('2099-09-09T09:00:00Z'), hasTime: true,
	priority: 4, recurrence: rule, reminderId: 'one',
}));
async function workspace(initialContent = content) {
	const { app, files } = createMockAppWithVault({ [path]: initialContent });
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error('Missing fixture');
	const index = createReminderIndex(app, 'Reminders');
	await index.rescanFile(file);
	const writer = createMarkdownWriter(app, index);
	return { files, index, repository: createReminderRepository(index, writer) };
}

describe('partial reminder updates', () => {
	it('returns the generated schedule when recurrence is added to an undated reminder', async () => {
		const { repository, index } = await workspace('# Inbox\n\n- [ ] Water plant <!-- crate-id:one -->\n');
		const returned = await repository.update('one', { recurrence: { frequency: 'daily', timezone: 'UTC' } });
		expect(returned).toEqual(toReminder(index.getById('one')!));
		expect(returned!.dueDate).toBeDefined();
	});
	it.each<UpdateReminderParams>([
		{ priority: 1 }, { content: 'Updated' }, { project: 'Other' }, { dueDate: '2099-09-10' },
		{ dueDatetime: '2099-09-10T10:00:00Z' }, { recurrence: null },
	])('preserves every omitted field through repository, writer and scanner: %j', async patch => {
		const { files, index, repository } = await workspace();
		const before = index.getById('one')!;
		const returned = await repository.update('one', patch);
		const after = index.getById('one')!;
		expect(returned).toEqual(toReminder(after));
		for (const field of ['content', 'description', 'priority', 'recurrence', 'completed', 'id', 'project', 'dueDate', 'dueDatetime'] as const) {
			if (field in patch || (field === 'dueDate' || field === 'dueDatetime') && ('dueDate' in patch || 'dueDatetime' in patch)) continue;
			// The rule holds the time of a timed due; a date-only due drops it again.
			if (field === 'recurrence' && patch.dueDate) expect(after.recurrence).toEqual(rule);
			else expect(after[field], field).toEqual(before[field]);
		}
		expect(files.get(after.filePath)).toContain('<!-- crate-desc:Important details\nKeep both lines -->');
	});

	it.each(['', undefined])('clears a description only when explicitly supplied as %j', async description => {
		const { files, index, repository } = await workspace();
		await repository.update('one', { description });
		expect(index.getById('one')?.description).toBeUndefined();
		expect(files.get(path)).not.toContain('crate-desc:');
	});
	it('returns the actual next recurring occurrence, final completion and reopened count', async () => {
		const { repository, index } = await workspace();
		const compare = async (result: ReturnType<typeof repository.complete>) => {
			const returned = await result;
			expect(returned).toEqual(toReminder(index.getById('one')!));
			return returned!;
		};
		const next = await compare(repository.complete('one'));
		expect(next.completed).toBe(false);
		expect(next.recurrence!.completedCount).toBe(2);
		await compare(repository.complete('one'));
		await compare(repository.complete('one'));
		const final = await compare(repository.complete('one'));
		expect(final.completed).toBe(true);
		expect(final.recurrence!.completedCount).toBe(5);
		const reopened = await compare(repository.uncomplete('one'));
		expect(reopened.completed).toBe(false);
		expect(reopened.dueDatetime).toBe(final.dueDatetime);
		expect(reopened.recurrence!.completedCount).toBe(4);
		expect(await compare(repository.complete('one'))).toEqual(final);
	});
});

describe('titles that would not read back', () => {
	it('refuses a create before writing and keeps the note readable', async () => {
		const { files, index, repository } = await workspace();
		await expect(repository.create({ content: 'Lunch at 1pm', project: 'Inbox', priority: 4, dueDate: '2026-10-30' }))
			.rejects.toThrow('This title cannot be saved as a reminder');
		expect(files.get(path)).toBe(content);
		expect(index.sourceIssues).toEqual([]);
		expect(index.getAll().map(reminder => reminder.id)).toEqual(['one']);

		await expect(repository.create({ content: 'Meet at noon', project: 'Reading', priority: 4, dueDate: '2026-10-30' })).rejects.toThrow(ReminderInputError);
		expect(files.has('Reminders/Reading.md')).toBe(false);
	});

	it('refuses an edit before writing', async () => {
		const { files, index, repository } = await workspace();
		await expect(repository.update('one', { content: 'Lunch at 1pm', dueDate: '2026-10-30', dueDatetime: undefined, recurrence: null }))
			.rejects.toThrow(ReminderInputError);
		expect(files.get(path)).toBe(content);
		expect(index.sourceIssues).toEqual([]);
		expect(index.getById('one')?.content).toBe('Original');
	});
});
