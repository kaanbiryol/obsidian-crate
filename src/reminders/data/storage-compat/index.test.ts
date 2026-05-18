import { describe, expect, it, vi } from 'vitest';
import type { ReminderIndex, IndexedReminder } from '../reminder-index';
import type { MarkdownWriter } from '../markdown-writer';
import { createStorageCompat } from '.';
import { timezone as getLocalTimeZone } from '../../utils/time';

function createIndex(overrides: Partial<ReminderIndex> = {}): ReminderIndex {
	return {
		isLoaded: true,
		remindersFolderPath: 'Reminders',
		getAll: () => [],
		getActive: () => [],
		getCompleted: () => [],
		getToday: () => [],
		getUpcoming: () => [],
		getOverdue: () => [],
		getByProject: () => [],
		getByFile: () => [],
		getById: () => undefined,
		getProjects: () => [],
		load: async () => ({ reminders: [], filesScanned: 0, totalLines: 0, scanDurationMs: 0, discoveredProjects: [] }),
		rescanFile: async () => {},
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

function createWriter(): {
	writer: MarkdownWriter;
	spies: {
		createReminder: ReturnType<typeof vi.fn>;
		updateReminder: ReturnType<typeof vi.fn>;
		deleteReminder: ReturnType<typeof vi.fn>;
		toggleComplete: ReturnType<typeof vi.fn>;
		reorderReminders: ReturnType<typeof vi.fn>;
	};
} {
	const createReminder = vi.fn(async () => {});
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
			setOnReminderChange: vi.fn(),
			setOnFileWritten: vi.fn(),
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

describe('storageCompat.create', () => {
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
			contentHash: 'hash',
		};
		const index = createIndex({
			getById: (id: string) => {
				persistedId = id;
				return { ...indexedReminder, id };
			},
		});
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		const created = await storage.create({
			content: 'Task A',
			project: 'Work',
			priority: 1,
		});

		expect(created.id).toBe(persistedId);
		expect(created.content).toBe('Task A');
		expect(spies.createReminder).toHaveBeenCalledWith(
			'Work',
			'Task A',
			undefined,
			1,
			undefined,
			undefined,
			created.id,
			undefined,
		);
	});

	it('passes recurrence through on create', async () => {
		const index = createIndex();
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		const recurrence = { frequency: 'daily' as const };
		const created = await storage.create({
			content: 'Task recur',
			project: 'Work',
			priority: 1,
			recurrence,
		});

		expect(spies.createReminder).toHaveBeenCalledWith(
			'Work',
			'Task recur',
			undefined,
			1,
			{ frequency: 'daily', timezone: getLocalTimeZone() },
			undefined,
			created.id,
			undefined,
		);
	});

	it('passes date-only reminders through with hasTime false', async () => {
		const index = createIndex();
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		await storage.create({
			content: 'Task dated',
			project: 'Work',
			priority: 4,
			dueDate: '2026-01-10',
		});

		const call = spies.createReminder.mock.calls[0];
		expect(call?.[0]).toBe('Work');
		expect(call?.[1]).toBe('Task dated');
		expect(call?.[2]).toEqual(new Date(2026, 0, 10));
		expect(call?.[5]).toBe(false);
	});

	it('returns the generated reminder id when optimistic state is unavailable', async () => {
		const index = createIndex();
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		const created = await storage.create({
			content: 'Task B',
			project: 'Inbox',
			priority: 4,
		});

		expect(created.id).toBe(spies.createReminder.mock.calls[0]?.[6]);
		expect(created.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	});
});

describe('storageCompat.update and today view', () => {
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
			contentHash: 'hash',
		};
		const index = createIndex({
			getById: (id: string) => id === 'r1' ? indexedReminder : undefined,
		});
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		await storage.update('r1', { recurrence: null });

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
			getToday: () => [{
				id: 'active',
				content: 'Active today',
				priority: 4,
				completed: false,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
				lineNumber: 2,
				rawLine: '- [ ] Active today',
				contentHash: 'hash-a',
				dueDate: '2026-01-10',
			}],
			getOverdue: () => [],
			getCompleted: () => [{
				id: 'completed',
				content: 'Done today',
				priority: 4,
				completed: true,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
				lineNumber: 3,
				rawLine: '- [x] Done today',
				contentHash: 'hash-b',
				dueDate: '2026-01-10',
			}],
		});
		const { writer } = createWriter();
		const storage = createStorageCompat(index, writer);

		expect(storage.getTodayReminders(true).map(reminder => reminder.id)).toEqual(['active', 'completed']);

		vi.useRealTimers();
	});

	it('routes delete, toggle, reorder, and stats to the underlying services', async () => {
		const indexedReminder: IndexedReminder = {
			id: 'r1',
			content: 'Task A',
			priority: 1,
			completed: false,
			project: 'Work',
			filePath: 'Reminders/Work.md',
			lineNumber: 2,
			rawLine: '- [ ] Task A',
			contentHash: 'hash',
		};
		const index = createIndex({
			getById: (id: string) => id === 'r1' ? indexedReminder : undefined,
			getActive: () => [indexedReminder],
			getCompleted: () => [{ ...indexedReminder, id: 'done', completed: true }],
		});
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		expect(await storage.delete('r1')).toBe(true);
		expect(spies.deleteReminder).toHaveBeenCalledWith(indexedReminder);

		const completed = await storage.complete('r1');
		expect(spies.toggleComplete).toHaveBeenNthCalledWith(1, indexedReminder);
		expect(completed?.completed).toBe(true);
		expect(completed?.completedAt).toEqual(expect.any(String));

		const uncompleted = await storage.uncomplete('r1');
		expect(spies.toggleComplete).toHaveBeenNthCalledWith(2, indexedReminder);
		expect(uncompleted?.completed).toBe(false);
		expect(uncompleted?.completedAt).toBeUndefined();

		await storage.reorder('Work', ['r1', 'done']);
		expect(spies.reorderReminders).toHaveBeenCalledWith('Reminders/Work.md', ['r1', 'done']);

		expect(storage.getStats()).toEqual({
			activeCount: 1,
			completedCount: 1,
			totalCount: 2,
		});
	});
});
