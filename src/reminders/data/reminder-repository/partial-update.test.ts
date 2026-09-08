import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderIndex } from '../reminder-index';
import { createMarkdownWriter } from '../markdown-writer';
import { createReminderRepository } from './index';
import { toReminder } from '../toReminder';
import { buildCreatedReminderBlock, appendCreatedReminderBlock } from '../../core/markdownReminderMutation';
import type { UpdateReminderParams } from '../../types/reminder';

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
	await index.rescanFile(file, true);
	const writer = createMarkdownWriter(app, index);
	writer.setOnFileWritten(written => index.rescanFile(written, true));
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
			expect(after[field], field).toEqual(before[field]);
		}
		expect(files.get(after.filePath)).toContain('<!-- crate-desc:v1:Important%20details%0AKeep%20both%20lines -->');
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
