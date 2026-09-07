import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderIndex } from '../reminder-index';
import { createMarkdownWriter } from '../markdown-writer';
import { createReminderRepository } from './index';
import { buildCreatedReminderBlock, appendCreatedReminderBlock } from '../../core/markdownReminderMutation';
import type { UpdateReminderParams } from '../../types/reminder';

const path = 'Reminders/Inbox.md';
const rule = { frequency: 'daily' as const, timezone: 'Europe/Berlin', count: 5, completedCount: 1 };
const content = appendCreatedReminderBlock('# Inbox\n', buildCreatedReminderBlock({
	content: 'Original', description: 'Important details\nKeep both lines', dueDate: new Date('2099-09-09T09:00:00Z'), hasTime: true,
	priority: 4, recurrence: rule, reminderId: 'one',
}));
async function workspace() {
	const { app, files } = createMockAppWithVault({ [path]: content });
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error('Missing fixture');
	const index = createReminderIndex(app, 'Reminders');
	await index.rescanFile(file, true);
	const writer = createMarkdownWriter(app, index);
	writer.setOnFileWritten(written => index.rescanFile(written, true));
	return { files, index, repository: createReminderRepository(index, writer) };
}

describe('partial reminder updates', () => {
	it.each<UpdateReminderParams>([
		{ priority: 1 }, { content: 'Updated' }, { project: 'Other' }, { dueDate: '2099-09-10' },
		{ dueDatetime: '2099-09-10T10:00:00Z' }, { recurrence: null },
	])('preserves every omitted field through repository, writer and scanner: %j', async patch => {
		const { files, index, repository } = await workspace();
		const before = index.getById('one')!;
		await repository.update('one', patch);
		const after = index.getById('one')!;
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
});
