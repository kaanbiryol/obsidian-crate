import { describe, expect, it } from 'vitest';
import { isCompletionInstant, setCompletionMarker } from './completionMetadata';
import { scanReminderMarkdownContent } from './markdownScan';
import { setReminderCompletionInContent } from './reminderCompletion';
import { buildCreatedReminderBlock, buildMovedReminderBlock, buildUpdatedReminderBlock } from './markdownReminderMutation';
import { normalizeReminderScheduleLine } from './normalizeReminderSchedule';
import { applyReminderFileCommand, reminderCommandPayload } from './reminderFileCommand';
import { reminderRevision } from './reminderRevision';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { predictReminderCompletion } from '@/pwa/reminders/outbox/reminder-optimistic-state';

const folder = 'Reminders', path = 'Reminders/Inbox.md';
const at = '2026-11-22T10:15:00.000Z', later = '2026-11-23T08:00:00.000Z';
const read = (content: string) => scanReminderMarkdownContent(path, content, folder).reminders[0]!;
const open = '- [ ] Pay the bill 2099-01-02 <!-- crate-id:r1 -->\n';

describe('completion marker', () => {
	it('accepts only exact UTC ISO instants', () => {
		expect(isCompletionInstant(at)).toBe(true);
		expect(isCompletionInstant('2026-11-22T10:15:00Z')).toBe(false);
		expect(isCompletionInstant('2026-11-22')).toBe(false);
		expect(isCompletionInstant('soon')).toBe(false);
	});

	it('reads a checked line\'s time and keeps the marker out of its title', () => {
		const reminder = read(`- [x] Pay the bill <!-- crate-done:${at} --> <!-- crate-id:r1 -->\n`);
		expect(reminder).toMatchObject({ completed: true, completedAt: at, content: 'Pay the bill' });
	});

	it('ignores a marker left on an unchecked line and a malformed one', () => {
		expect(read(`- [ ] Pay the bill <!-- crate-done:${at} --> <!-- crate-id:r1 -->\n`)).not.toHaveProperty('completedAt');
		const malformed = read('- [x] Pay the bill <!-- crate-done:yesterday --> <!-- crate-id:r1 -->\n');
		expect(malformed).toMatchObject({ completed: true, content: 'Pay the bill' });
		expect(malformed).not.toHaveProperty('completedAt');
	});

	it('replaces a marker and keeps a CRLF line ending', () => {
		expect(setCompletionMarker(`- [x] Task <!-- crate-done:${at} --> <!-- crate-id:r1 -->\r`, later))
			.toBe(`- [x] Task <!-- crate-id:r1 --> <!-- crate-done:${later} -->\r`);
		expect(setCompletionMarker(`- [ ] Task <!-- crate-done:${at} -->`, undefined)).toBe('- [ ] Task');
	});
});

describe('completion time', () => {
	it('is written on completion, kept on a repeated completion and removed on reopening', () => {
		let content = setReminderCompletionInContent(open, read(open), true, undefined, at).content;
		expect(content).toBe(`- [x] Pay the bill 2099-01-02 <!-- crate-done:${at} --> <!-- crate-id:r1 -->\n`);
		expect(read(content)).toMatchObject({ completed: true, completedAt: at, dueDate: '2099-01-02' });
		expect(setReminderCompletionInContent(content, read(content), true, undefined, later).content).toBe(content);
		content = setReminderCompletionInContent(content, read(content), false, undefined, later).content;
		expect(content).toBe(open);
	});

	it('keeps CRLF line endings', () => {
		const crlf = open.replace('\n', '\r\n');
		const content = setReminderCompletionInContent(crlf, read(crlf), true, undefined, at).content;
		expect(content.endsWith(' <!-- crate-id:r1 -->\r\n')).toBe(true);
		expect(read(content).completedAt).toBe(at);
	});

	it('is not set while a recurring reminder moves on, and is set on its last occurrence', () => {
		const block = buildCreatedReminderBlock({ content: 'Daily task', reminderId: 'r1', priority: 4,
			dueDate: new Date('2099-01-01T09:00:00Z'), hasTime: true,
			recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0, count: 2 } }).checkboxLine;
		let content = setReminderCompletionInContent(block, read(block), true, undefined, at).content;
		expect(read(content)).toMatchObject({ completed: false, dueDatetime: '2099-01-02T09:00:00.000Z' });
		expect(content).not.toContain('crate-done');
		content = setReminderCompletionInContent(content, read(content), true, undefined, later).content;
		expect(read(content)).toMatchObject({ completed: true, completedAt: later });
		content = setReminderCompletionInContent(content, read(content), false, undefined, later).content;
		expect(content).not.toContain('crate-done');
	});

	it('is predicted by the PWA exactly as the note records it', () => {
		const record = { ...read(open), revision: 'r' };
		const content = setReminderCompletionInContent(open, read(open), true, undefined, at).content;
		expect(predictReminderCompletion(record, true, at)).toMatchObject({ completed: true, completedAt: read(content).completedAt });
		expect(predictReminderCompletion({ ...record, ...read(content) }, false, later).completedAt).toBeUndefined();
	});

	it('survives edits, moves and schedule normalization', () => {
		const done = `- [x] Pay the bill 2099-01-02 <!-- crate-done:${at} --> <!-- crate-id:r1 -->`;
		const record = { ...read(done), filePath: path };
		expect(buildUpdatedReminderBlock(record, { content: 'Pay the gas bill' }).checkboxLine).toContain(`<!-- crate-done:${at} -->`);
		expect(buildMovedReminderBlock(record, {}).checkboxLine).toContain(`<!-- crate-done:${at} -->`);
		const draft = `- [x] Pay the bill tomorrow <!-- crate-done:${at} --> <!-- crate-id:r1 -->`;
		expect(normalizeReminderScheduleLine(draft)).toContain(`<!-- crate-done:${at} -->`);
	});

	it('is part of the revision', async () => {
		const reminder = read(open);
		expect(await reminderRevision({ ...reminder, completed: true, completedAt: at }))
			.not.toBe(await reminderRevision({ ...reminder, completed: true }));
	});
});

describe('set-completed command', () => {
	async function body(content: string) {
		const reminder = await reminderCommandPayload(read(content));
		return { folderPath: folder, operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)),
			id: reminder.id, filePath: path, expectedRevision: reminder.revision };
	}

	it('writes the requested time, and a resent request writes the same bytes', async () => {
		const request = { ...await body(open), completed: true, completedAt: at };
		const first = await applyReminderFileCommand('set-completed', request, folder, async () => open);
		expect(first.files[0]!.content).toContain(`<!-- crate-done:${at} -->`);
		expect(first.response).toMatchObject({ reminder: { completed: true, completedAt: at } });
		const resent = await applyReminderFileCommand('set-completed', { ...request, expectedRevision: (await body(first.files[0]!.content)).expectedRevision },
			folder, async () => first.files[0]!.content);
		expect(resent.files[0]!.content).toBe(first.files[0]!.content);
	});

	it('completes a request queued before completion times existed', async () => {
		const completed = await applyReminderFileCommand('set-completed', { ...await body(open), completed: true }, folder, async () => open);
		expect(completed.files[0]!.content).toMatch(/^- \[x\] Pay the bill/);
	});

	it('rejects an invalid time when completing, and needs none to reopen', async () => {
		await expect(applyReminderFileCommand('set-completed', { ...await body(open), completed: true, completedAt: 'now' }, folder, async () => open))
			.rejects.toMatchObject({ status: 400, code: 'invalid_reminder_input' });
		const done = `- [x] Pay the bill 2099-01-02 <!-- crate-done:${at} --> <!-- crate-id:r1 -->\n`;
		const reopened = await applyReminderFileCommand('set-completed', { ...await body(done), completed: false }, folder, async () => done);
		expect(reopened.files[0]!.content).toBe(open);
	});
});
