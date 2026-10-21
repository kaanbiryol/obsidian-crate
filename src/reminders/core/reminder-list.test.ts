import { describe, expect, it } from 'vitest';
import { buildReminderList, compareProjects, REMINDER_IDENTITY_CONFLICT_ISSUE } from './reminder-list';

const reminder = (id: string, filePath: string) => ({ id, filePath });
const source = (path: string, ids: string[], issue?: string) => ({
	path, project: path.slice('Reminders/'.length, -'.md'.length), reminders: ids.map(id => reminder(id, path)), issue,
});

describe('buildReminderList', () => {
	it('hides every copy of an ID duplicated across files and keeps file order', () => {
		const result = buildReminderList([
			source('Reminders/Inbox.md', ['first', 'shared']),
			source('Reminders/Work.md', ['shared', 'second']),
			source('Reminders/Home.md', ['third']),
		]);
		expect(result.reminders).toEqual([
			reminder('first', 'Reminders/Inbox.md'), reminder('second', 'Reminders/Work.md'), reminder('third', 'Reminders/Home.md'),
		]);
		expect(result.issues).toEqual([
			{ path: 'Reminders/Inbox.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE },
			{ path: 'Reminders/Work.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE },
		]);
	});

	it('reports one issue per affected file however many of its reminders conflict', () => {
		const result = buildReminderList([
			source('Reminders/Inbox.md', ['a', 'b', 'a', 'c']),
			source('Reminders/Work.md', ['b', 'c', 'd']),
		]);
		expect(result.reminders.map(item => item.id)).toEqual(['d']);
		expect(result.issues).toEqual([
			{ path: 'Reminders/Inbox.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE },
			{ path: 'Reminders/Work.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE },
		]);
	});

	it("keeps a file's own issue in place of the conflict and still lists its project", () => {
		const result = buildReminderList([
			source('Reminders/Inbox.md', ['shared'], 'Too many scheduled reminders'),
			source('Reminders/Work.md', ['shared']),
			source('Reminders/Large.md', [], 'Split this note'),
		]);
		expect(result.reminders).toEqual([]);
		expect(result.issues).toEqual([
			{ path: 'Reminders/Inbox.md', reason: 'Too many scheduled reminders' },
			{ path: 'Reminders/Work.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE },
			{ path: 'Reminders/Large.md', reason: 'Split this note' },
		]);
		expect(result.projects).toEqual(['Inbox', 'Large', 'Work']);
	});

	it('lists each project once in compareProjects order, including mixed case and non-ASCII names', () => {
		const names = ['work', 'Zeta', 'Été', 'Inbox', 'apple', 'Ärger', 'work'];
		const result = buildReminderList(names.map((name, index) => ({ path: `Reminders/${name}-${index}.md`, project: name, reminders: [] })));
		expect(result.projects).toEqual(['apple', 'Ärger', 'Été', 'Inbox', 'work', 'Zeta']);
		expect(result.issues).toEqual([]);
	});
});

describe('compareProjects', () => {
	it('orders by locale rather than code unit', () => {
		expect(['b', 'B', 'a', 'Ä', 'Z'].sort(compareProjects)).toEqual(['a', 'Ä', 'b', 'B', 'Z']);
	});
});
