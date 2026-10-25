import { reminderRevision } from '../core/reminderRevision';
import { toReminder } from './toReminder';
import { describe, expect, it, vi } from 'vitest';
import type { ReminderIndex, IndexedReminder } from './reminder-index';
import type { MarkdownWriter } from './markdown-writer';
import { createReminderRepository } from './reminder-repository';
import { timezone as getLocalTimeZone } from '../core/dates/time';

function createIndex(overrides: Partial<ReminderIndex> = {}): ReminderIndex {
	return {
		isInitialLoadComplete: true,
		sourceIssues: [],
		remindersFolderPath: 'Reminders',
		getAll: () => [],
		getActive: () => [],
		getById: () => undefined,
		getProjects: () => [],
		load: async () => ({ reminders: [], issues: [], filesScanned: 0, totalLines: 0, scanDurationMs: 0, discoveredProjects: [] }),
		rescanFile: async () => {},
		flushDeferredScans: async () => {},
		removeFile: () => {},
		renameFile: () => {},
		isReminderFile: () => true,
		onIndexChange: () => () => {},
		applyOptimisticCreate: () => {},
		applyOptimisticUpdate: () => {},
		applyOptimisticDelete: () => {},
		clearOptimistic: () => {},
		...overrides,
	};
}

/** An index that reads back what the writer created, as a successful rescan does. */
function indexReflectingCreates(): ReminderIndex {
	return createIndex({ getById: id => ({ id, content: 'Created', priority: 4, completed: false, project: 'Inbox', filePath: 'Reminders/Inbox.md', lineNumber: 0, rawLine: '- [ ] Created' }) });
}

function createWriter(): {
	writer: MarkdownWriter;
	spies: {
		createReminder: ReturnType<typeof vi.fn<MarkdownWriter['createReminder']>>;
		updateReminder: ReturnType<typeof vi.fn>;
		deleteReminder: ReturnType<typeof vi.fn>;
		toggleComplete: ReturnType<typeof vi.fn>;
		reorderReminders: ReturnType<typeof vi.fn>;
	};
} {
	const createReminder = vi.fn<MarkdownWriter['createReminder']>(async () => {});
	const updateReminder = vi.fn(async () => {});
	const deleteReminder = vi.fn(async () => {});
	const toggleComplete = vi.fn(async () => {});
	const reorderReminders = vi.fn(async () => {});
	return {
		writer: {
			createReminder,
			updateReminder,
			deleteReminder,
			toggleComplete,
			reorderReminders,
		},
		spies: {
			createReminder,
			updateReminder,
			deleteReminder,
			toggleComplete,
			reorderReminders,
		},
	};
}

describe('reminderRepository.create', () => {
	it('returns the persisted reminder id when the index already reflects the create', async () => {
		const filePath = 'Reminders/Work.md';
		let persistedId: string | undefined;
		const indexedReminder: Omit<IndexedReminder, 'id'> = {
			content: 'Task A',
			priority: 1,
			completed: false,
			project: 'Work',
			filePath,
			lineNumber: 2,
			rawLine: '- [ ] Task A',
		};
		const index = createIndex({
			getById: (id: string) => {
				persistedId = id;
				return { ...indexedReminder, id };
			},
		});
		const { writer, spies } = createWriter();
		const repository = createReminderRepository(index, writer);

		const created = await repository.create({
			content: 'Task A',
			project: 'Work',
			priority: 1,
		});

		expect(created.id).toBe(persistedId);
		expect(created.content).toBe('Task A');
		expect(spies.createReminder).toHaveBeenCalledWith({
			project: 'Work',
			content: 'Task A',
			dueDate: undefined,
			priority: 1,
			recurrence: undefined,
			hasTime: undefined,
			reminderId: created.id,
			description: undefined,
		});
	});

	it('passes recurrence through on create', async () => {
		const index = indexReflectingCreates();
		const { writer, spies } = createWriter();
		const repository = createReminderRepository(index, writer);

		const recurrence = { frequency: 'daily' as const };
		const created = await repository.create({
			content: 'Task recur',
			project: 'Work',
			priority: 1,
			recurrence,
		});

		expect(spies.createReminder).toHaveBeenCalledWith({
			project: 'Work',
			content: 'Task recur',
			dueDate: undefined,
			priority: 1,
			recurrence: { frequency: 'daily', timezone: getLocalTimeZone() },
			hasTime: undefined,
			reminderId: created.id,
			description: undefined,
		});
	});

	it('passes date-only reminders through with hasTime false', async () => {
		const index = indexReflectingCreates();
		const { writer, spies } = createWriter();
		const repository = createReminderRepository(index, writer);

		await repository.create({
			content: 'Task dated',
			project: 'Work',
			priority: 4,
			dueDate: '2026-01-10',
		});

		const input = spies.createReminder.mock.calls[0]?.[0];
		expect(input?.project).toBe('Work');
		expect(input?.content).toBe('Task dated');
		expect(input?.dueDate).toEqual(new Date(2026, 0, 10));
		expect(input?.hasTime).toBe(false);
	});

	it('reports a created line that does not read back instead of inventing a reminder', async () => {
		const index = createIndex();
		const { writer, spies } = createWriter();
		const repository = createReminderRepository(index, writer);

		await expect(repository.create({ content: 'Task B', project: 'Inbox', priority: 4 })).rejects.toThrow('could not be read back');
		expect(spies.createReminder.mock.calls[0]?.[0]?.reminderId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	});
});

describe('reminderRepository.update and today view', () => {
	it('passes recurrence removal through to the writer', async () => {
		const indexedReminder: IndexedReminder = {
			id: 'r1',
			content: 'Task A',
			priority: 1,
			completed: false,
			project: 'Work',
			recurrence: { frequency: 'daily' },
			dueDate: '2026-01-10',
			filePath: 'Reminders/Work.md',
			lineNumber: 2,
			rawLine: '- [ ] Task A every day',
		};
		const index = createIndex({
			getById: (id: string) => id === 'r1' ? indexedReminder : undefined,
		});
		const { writer, spies } = createWriter();
		const repository = createReminderRepository(index, writer);

		await repository.update('r1', { recurrence: null });

		expect(spies.updateReminder).toHaveBeenCalledWith(
			indexedReminder,
			expect.objectContaining({ recurrence: null }),
		);
		const updateCall = spies.updateReminder.mock.calls[0] as
			| [IndexedReminder, Parameters<MarkdownWriter['updateReminder']>[1]]
			| undefined;
		const updates = updateCall?.[1];
		expect(Object.prototype.hasOwnProperty.call(updates ?? {}, 'dueDate')).toBe(false);
	});

	it('includes completed reminders due today when requested', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 10, 9, 0, 0));

		const index = createIndex({
			getAll: () => [{
				id: 'active',
				content: 'Active today',
				priority: 4,
				completed: false,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
				lineNumber: 2,
				rawLine: '- [ ] Active today',
				dueDate: '2026-01-10',
			}, {
				id: 'completed',
				content: 'Done today',
				priority: 4,
				completed: true,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
				lineNumber: 3,
				rawLine: '- [x] Done today',
				dueDate: '2026-01-10',
			}],
		});
		const { writer } = createWriter();
		const repository = createReminderRepository(index, writer);

		expect(repository.getTodayReminders(true).map(reminder => reminder.id)).toEqual(['active', 'completed']);

		vi.useRealTimers();
	});

	it('routes delete, toggle, and reorder to the underlying services', async () => {
		let indexedReminder: IndexedReminder = {
			id: 'r1',
			content: 'Task A',
			priority: 1,
			completed: false,
			project: 'Work',
			filePath: 'Reminders/Work.md',
			lineNumber: 2,
			rawLine: '- [ ] Task A',
		};
		const index = createIndex({
			getById: (id: string) => id === 'r1' ? indexedReminder : undefined,
		});
		const { writer, spies } = createWriter();
		const repository = createReminderRepository(index, writer);

		expect(await repository.delete('r1')).toBe(true);
		expect(spies.deleteReminder).toHaveBeenCalledWith(indexedReminder);

		spies.toggleComplete.mockImplementation(() => { indexedReminder = { ...indexedReminder, completed: !indexedReminder.completed }; });
		const beforeComplete = indexedReminder;
		const completed = await repository.complete('r1');
		expect(spies.toggleComplete).toHaveBeenNthCalledWith(1, beforeComplete);
		expect(completed?.completed).toBe(true);

		indexedReminder = { ...indexedReminder, completed: true };
		const beforeUncomplete = indexedReminder;
		const uncompleted = await repository.uncomplete('r1');
		expect(spies.toggleComplete).toHaveBeenNthCalledWith(2, beforeUncomplete);
		expect(uncompleted?.completed).toBe(false);

		await repository.reorder('Work', ['r1', 'done']);
		expect(spies.reorderReminders).toHaveBeenCalledWith('Reminders/Work.md', ['r1', 'done']);
	});

	it('does not toggle reminders that are already in the requested completion state', async () => {
		let indexedReminder: IndexedReminder = {
			id: 'r1',
			content: 'Task A',
			priority: 1,
			completed: true,
			project: 'Work',
			filePath: 'Reminders/Work.md',
			lineNumber: 2,
			rawLine: '- [x] Task A',
		};
		const index = createIndex({
			getById: (id: string) => id === 'r1' ? indexedReminder : undefined,
		});
		const { writer, spies } = createWriter();
		const repository = createReminderRepository(index, writer);

		const completed = await repository.complete('r1');
		expect(completed?.completed).toBe(true);
		expect(spies.toggleComplete).not.toHaveBeenCalled();

		indexedReminder = { ...indexedReminder, completed: false, rawLine: '- [ ] Task A' };
		const uncompleted = await repository.uncomplete('r1');

		expect(uncompleted?.completed).toBe(false);
		expect(spies.toggleComplete).not.toHaveBeenCalled();
	});
});

it('rejects a stale modal update and delete even when the current index is fresh', async () => {
  const original = { id: 'one', content: 'Original', priority: 4, completed: false, project: 'Inbox', filePath: 'Reminders/Inbox.md', lineNumber: 1, rawLine: '- [ ] Original' } as IndexedReminder;
  const expectedRevision = await reminderRevision(toReminder(original));
  const index = createIndex({ getById: () => ({ ...original, content: 'Changed on another device' }) });
  const { writer, spies } = createWriter();
  const repository = createReminderRepository(index, writer);
  await expect(repository.update('one', { content: 'Stale draft', expectedRevision })).rejects.toThrow('changed');
  await expect(repository.delete('one', expectedRevision)).rejects.toThrow('changed');
  expect(spies.updateReminder).not.toHaveBeenCalled();
  expect(spies.deleteReminder).not.toHaveBeenCalled();
});

it('keeps converted reminders identical until their indexed record changes', () => {
	const record: IndexedReminder = { id: 'one', content: 'Task', priority: 4, completed: false, filePath: 'Reminders/A.md',
		project: 'A', lineNumber: 0, rawLine: '- [ ] Task' };
	const repository = createReminderRepository(createIndex({ getAll: () => [record] }), {} as MarkdownWriter);
	const first = repository.getAll()[0];
	expect(repository.getAll()[0]).toBe(first);
	// The index moves records in place when a note is renamed.
	record.project = 'B';
	const moved = repository.getAll()[0];
	expect(moved).not.toBe(first);
	expect(moved?.project).toBe('B');
});

it('builds Today from one index read and reuses converted reminders', () => {
	const now = new Date();
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	const reminder = (id: string, dueDate: string, completed = false): IndexedReminder => ({
		id, content: id, priority: 4, completed, dueDate, project: 'Inbox', filePath: 'Reminders/Inbox.md', lineNumber: 0, rawLine: `- [ ] ${id}` });
	const all = [reminder('today', today), reminder('late', '2020-01-01'), reminder('done', today, true), reminder('later', '2999-01-01')];
	const getAll = vi.fn(() => all);
	const repository = createReminderRepository(createIndex({ getAll }), {} as MarkdownWriter);
	const first = repository.getTodayReminders(true);
	expect(first.map(item => item.id)).toEqual(['today', 'late', 'done']);
	expect(repository.getTodayReminders(true)[0]).toBe(first[0]);
	// Before: three merged index reads per query and new reminder objects every time.
	expect(getAll).toHaveBeenCalledTimes(2);
});
