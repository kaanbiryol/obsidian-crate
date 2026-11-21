import { describe, expect, it } from 'vitest';
import { appendArchivedBlocks, hasArchivedBlock, planReminderArchive, removeArchivedBlocks } from './reminder-archive';

const done = (id: string, title = `Done ${id}`) => `- [x] ${title} <!-- crate-id:${id} -->`;
const open = (id: string) => `- [ ] Open ${id} <!-- crate-id:${id} -->`;
const description = '<!-- crate-desc:v1:collect%20receipts -->';

describe('planReminderArchive', () => {
	it('plans completed top-level reminders with their descriptions and keeps open ones', () => {
		const content = ['# Inbox', '', open('a'), done('b'), description, open('c'), done('d'), ''].join('\n');
		expect(planReminderArchive(content)).toEqual({
			blocks: [{ id: 'b', block: `${done('b')}\n${description}` }, { id: 'd', block: done('d') }],
			skipped: 0,
		});
	});

	it('skips nested reminders, reminders with children and duplicate identities', () => {
		const content = [
			open('parent'), `\t${done('child')}`,
			done('has-children'), '\t- [ ] Subtask',
			done('twice'), done('twice'),
			done('no-id').replace(/ <!--.*-->/, ''),
		].join('\n');
		expect(planReminderArchive(content)).toEqual({ blocks: [], skipped: 5 });
	});

	it('ignores checkboxes in code blocks', () => {
		expect(planReminderArchive(['```', done('code'), '```'].join('\n'))).toEqual({ blocks: [], skipped: 0 });
	});
});

describe('removeArchivedBlocks', () => {
	it('removes only blocks that are still stored exactly', () => {
		const content = [open('a'), done('b'), description, done('c', 'Edited'), ''].join('\n');
		const result = removeArchivedBlocks(content, [{ id: 'b', block: `${done('b')}\n${description}` }, { id: 'c', block: done('c') }]);
		expect(result).toEqual({ content: [open('a'), done('c', 'Edited'), ''].join('\n'), removed: ['b'] });
	});

	it('keeps CRLF notes byte for byte outside the removed lines', () => {
		const content = `${open('a')}\r\n${done('b')}\r\n${open('c')}\r\n`;
		expect(removeArchivedBlocks(content, [{ id: 'b', block: `${done('b')}\r` }]).content).toBe(`${open('a')}\r\n${open('c')}\r\n`);
	});
});

describe('appendArchivedBlocks', () => {
	it('creates an archive and appends later runs at the end', () => {
		const first = appendArchivedBlocks('', [{ id: 'a', block: done('a') }]);
		expect(first.content).toBe(`${done('a')}\n`);
		const second = appendArchivedBlocks(first.content, [{ id: 'b', block: `${done('b')}\n${description}` }]);
		expect(second.content).toBe(`${done('a')}\n${done('b')}\n${description}\n`);
	});

	it('adds a line break to a note that lacks a final one', () => {
		expect(appendArchivedBlocks('# Old', [{ id: 'a', block: done('a') }]).content).toBe(`# Old\n${done('a')}\n`);
	});

	it('replaces an older copy so each reminder is archived once', () => {
		const archive = `${done('a', 'Old title')}\n${done('b')}\n`;
		const result = appendArchivedBlocks(archive, [{ id: 'a', block: done('a', 'New title') }]);
		expect(result.content).toBe(`${done('b')}\n${done('a', 'New title')}\n`);
		expect(result.appended.map(block => block.id)).toEqual(['a']);
		expect(result.replaced).toEqual([{ id: 'a', block: done('a', 'Old title') }]);
	});

	it('leaves a reminder in its project when its archived copy cannot be replaced safely', () => {
		const archive = `${done('a')}\n\t- [ ] Subtask\n`;
		expect(appendArchivedBlocks(archive, [{ id: 'a', block: done('a') }])).toEqual({ content: archive, appended: [], replaced: [] });
	});

	it('writes blocks in the archive line ending', () => {
		const result = appendArchivedBlocks(`${done('a')}\r\n`, [{ id: 'b', block: `${done('b')}\n${description}` }]);
		expect(result.content).toBe(`${done('a')}\r\n${done('b')}\r\n${description}\r\n`);
		expect(hasArchivedBlock(result.content, { id: 'b', block: `${done('b')}\n${description}` })).toBe(true);
	});
});
