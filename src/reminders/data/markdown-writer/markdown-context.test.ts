import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderIndex } from '../reminder-index';
import { createReminderRepository } from '../reminder-repository';
import { createMarkdownWriter } from './index';

const path = 'Reminders/Inbox.md';
const first = '- [ ] First <!-- crate-id:first -->';
const second = '- [ ] Second <!-- crate-id:second -->';
async function workspace(content: string) {
	const { app, files } = createMockAppWithVault({ [path]: content });
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error('Missing fixture');
	const index = createReminderIndex(app, 'Reminders');
	await index.rescanFile(file, true);
	const writer = createMarkdownWriter(app, index);
	writer.setOnFileWritten(written => index.rescanFile(written, true));
	return { files, index, writer, repository: createReminderRepository(index, writer) };
}

describe('real reminder writes respect Markdown context', () => {
	it.each(['```md', '~~~md', '````md'])('preserves examples through adoption, indexing and reorder inside %s', async fence => {
			const closing = fence.replace('md', '');
			const example = `${fence}\n- [ ] Example tomorrow <!-- crate-id:first -->\n<!-- crate-desc:v1:%invalid -->\n${closing}\n\n`;
			const { files, index, repository } = await workspace(`${example}${first}\n${second}\n`);
			expect(index.getAll().map(reminder => reminder.id)).toEqual(['first', 'second']);
			await repository.reorder('Inbox', ['second', 'first']);
			expect(files.get(path)).toBe(`${example}${second}\n${first}\n`);
	});

	it.each([
		'- ```md\n  - [ ] Example tomorrow <!-- crate-id:first -->\n  ```',
		'- <pre>\n  - [ ] Example tomorrow <!-- crate-id:first -->\n  </pre>',
		'<details>\n<details>\n- [ ] Inner tomorrow\n</details>\n- [ ] Outer tomorrow <!-- crate-id:first -->\n</details>',
	])('does not adopt list-container or nested HTML examples: %s', async example => {
		const content = `${example}\n\n${first}\n${second}\n`;
		const { files, index, repository } = await workspace(content);
		expect(files.get(path)).toBe(content);
		expect(index.getAll().map(reminder => reminder.id)).toEqual(['first', 'second']);
		await repository.reorder('Inbox', ['second', 'first']);
		expect(files.get(path)).toBe(`${example}\n\n${second}\n${first}\n`);
	});

	it.each([
		`${first}\n## Different section\n${second}\n`,
		`${first}\n\nSupporting paragraph\n\n${second}\n`,
		`${first}\n  Supporting details\n${second}\n`,
		`${first}\nLazy continuation\n${second}\n`,
		`${first}\n\n  Indented details\n${second}\n`,
		`${first}\n  - [ ] Child <!-- crate-id:child -->\n${second}\n`,
		`${first}\n~~~\nExample\n~~~\n${second}\n`,
	])('rejects structural reorder without editing source bytes', async content => {
		const { files, repository } = await workspace(content);
		await expect(repository.reorder('Inbox', ['second', 'first'])).rejects.toThrow('in Markdown');
		expect(files.get(path)).toBe(content);
	});

	it('rejects removal or project moves that would detach children, while allowing title edits', async () => {
		const child = '  - [ ] Child <!-- crate-id:child -->';
		const content = `${first}\n${child}\n${second}\n`;
		const { files, index, writer } = await workspace(content);
		const reminder = index.getById('first')!;
		await expect(writer.deleteReminder(reminder)).rejects.toThrow('nested tasks or supporting text');
		await expect(writer.updateReminder(reminder, { project: 'Other' })).rejects.toThrow('nested tasks or supporting text');
		expect(files.get(path)).toBe(content);
		expect(files.get('Reminders/Other.md')).not.toContain('crate-id:first');
		await writer.updateReminder(reminder, { content: 'Edited' });
		expect(files.get(path)).toBe(`${first.replace('First', 'Edited')}\n${child}\n${second}\n`);
	});

	it('does not update, complete, delete, or reorder an indexed reminder that was moved into a code example', async () => {
		const { files, index, writer, repository } = await workspace(`${first}\n${second}\n`);
		const reminder = index.getById('first')!;
		const current = `~~~md\n${first}\n~~~\n${second}\n`;
		files.set(path, current);
		await expect(writer.updateReminder(reminder, { content: 'Edited' })).rejects.toThrow('locate');
		await expect(writer.toggleComplete(reminder)).rejects.toThrow('locate');
		await writer.deleteReminder(reminder);
		await expect(repository.reorder('Inbox', ['second', 'first'])).rejects.toThrow('Reminder order changed');
		expect(files.get(path)).toBe(current);
	});

	it.each(['```md', '<!--', '<pre>', '---'])('rejects appending a new reminder into an unclosed hidden block: %s', async content => {
		const { files, writer } = await workspace(content);
		await expect(writer.createReminder('Inbox', 'New task', undefined, 4)).rejects.toThrow('Close the code or hidden Markdown block');
		expect(files.get(path)).toBe(content);
	});
});
