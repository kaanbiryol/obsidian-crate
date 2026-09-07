import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderIndex } from '../reminder-index';
import { createReminderRepository } from '../reminder-repository';
import { createMarkdownWriter } from './index';

const path = 'Reminders/Inbox.md';
const original = '- [ ] Original <!-- crate-id:first -->';
const another = '- [ ] Another <!-- crate-id:second -->';
const initialContent = `${original}\n${another}\n`;

async function createIndexedWorkspace() {
	const { app, files } = createMockAppWithVault({ [path]: initialContent });
	app.vault.cachedRead = file => app.vault.read(file);
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error('Test project file is missing');
	const index = createReminderIndex(app, 'Reminders');
	await index.rescanFile(file, true);
	const writer = createMarkdownWriter(app, index);
	writer.setOnFileWritten(written => index.rescanFile(written, true));
	return { files, index, repository: createReminderRepository(index, writer) };
}

describe('repository reorder against current Markdown', () => {
	it.each([' ', 'x'])('rejects a pasted duplicate ID before the debounced scan (%s checkbox)', async checkbox => {
		const { files, repository, index } = await createIndexedWorkspace();
		// An editor paste preserves its invisible ID. The watcher has not yet
		// rescanned, so the sidebar still offers the two indexed reminders.
		const current = `${initialContent}- [${checkbox}] Pasted extra details <!-- crate-id:first -->\n`;
		files.set(path, current);
		expect(index.getAll()).toHaveLength(2);

		await expect(repository.reorder('Inbox', ['second', 'first'])).rejects.toThrow('Duplicate reminder identifiers');

		expect(files.get(path)).toBe(current);
		expect(index.getAll().map(reminder => reminder.id)).toEqual(['first', 'second']);
	});

	it('rejects duplicate IDs in a newly added block even when that ID is absent from the request', async () => {
		const { files, repository } = await createIndexedWorkspace();
		const current = `${initialContent}- [ ] Added <!-- crate-id:new -->\n- [ ] Copied <!-- crate-id:new -->\n`;
		files.set(path, current);

		await expect(repository.reorder('Inbox', ['second', 'first'])).rejects.toThrow('Duplicate reminder identifiers');
		expect(files.get(path)).toBe(current);
	});

	it.each([
		{ order: ['first', 'first'], current: initialContent },
		{ order: ['second', 'first'], current: `${another}\n` },
		{ order: ['second', 'first'], current: `${original.replace('[ ]', '[x]')}\n${another}\n` },
		{ order: ['second', 'other-project-id'], current: initialContent },
	])('rejects duplicate or stale requested ownership without changing the file: $order', async ({ order, current }) => {
		const { files, repository } = await createIndexedWorkspace();
		files.set(path, current);

		await expect(repository.reorder('Inbox', order)).rejects.toThrow('Reminder order changed');
		expect(files.get(path)).toBe(current);
	});

	it('reorders current task blocks while preserving concurrent edits and unrequested blocks in place', async () => {
		const { files, repository, index } = await createIndexedWorkspace();
		const edited = '- [ ] Edited in Markdown <!-- crate-id:first -->\n<!-- crate-desc:v1:Important%20details -->';
		const added = '- [ ] Added after indexing <!-- crate-id:new -->';
		const done = '- [x] Completed after indexing <!-- crate-id:done -->';
		const unindexed = '- [ ] Unindexed task';
		files.set(path, `# Inbox\n\n${edited}\n${added}\n${done}\n${unindexed}\n${another}\nFooter\n`);

		await repository.reorder('Inbox', ['second', 'first']);

		// Postwrite indexing adopts a new ID for the previously unindexed task.
		const adopted = index.getAll().find(reminder => reminder.content === 'Unindexed task');
		expect(adopted).toBeDefined();
		expect(files.get(path)).toBe(`# Inbox\n\n${another}\n${added}\n${done}\n${unindexed} <!-- crate-id:${adopted?.id} -->\n${edited}\nFooter\n`);
		expect(index.getById('first')?.description).toBe('Important details');
		expect(index.getAll()).toHaveLength(5);
	});

	it('does not alter unrelated blocks when a page supplies only some project IDs', async () => {
		const { files, repository } = await createIndexedWorkspace();
		const added = '- [ ] Concurrent task <!-- crate-id:new -->';
		files.set(path, `${original}\n${added}\n${another}\n`);

		await repository.reorder('Inbox', ['second']);

		expect(files.get(path)).toBe(`${original}\n${added}\n${another}\n`);
	});
});
