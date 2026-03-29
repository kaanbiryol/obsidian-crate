import { describe, expect, it, vi } from 'vitest';
import type { ReminderIndex, IndexedReminder } from './reminderIndex';
import type { MarkdownWriter } from './markdownWriter';
import { createStorageCompat } from './storageCompat';
import { generateReminderId } from './reminderIdentity';

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
	};
} {
	const createReminder = vi.fn(async () => {});
	const updateReminder = vi.fn(async () => {});
	return {
		writer: {
			createReminder,
			updateReminder,
			deleteReminder: vi.fn(async () => {}),
			toggleComplete: vi.fn(async () => {}),
			setOnReminderChange: vi.fn(),
			setOnFileWritten: vi.fn(),
		},
		spies: {
			createReminder,
			updateReminder,
		},
	};
}

describe('storageCompat.create', () => {
	it('returns the optimistic reminder id instead of a random placeholder', async () => {
		const filePath = 'Reminders/Work.md';
		const reminderId = generateReminderId(filePath, 'Task A');
		const indexedReminder: IndexedReminder = {
			id: reminderId,
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
			getById: (id: string) => id === reminderId ? indexedReminder : undefined,
		});
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		const created = await storage.create({
			content: 'Task A',
			project: 'Work',
			priority: 1,
		});

		expect(created.id).toBe(reminderId);
		expect(created.content).toBe('Task A');
		expect(spies.createReminder).toHaveBeenCalledWith('Work', 'Task A', undefined, 1, undefined);
	});

	it('passes recurrence through on create', async () => {
		const index = createIndex();
		const { writer, spies } = createWriter();
		const storage = createStorageCompat(index, writer);

		const recurrence = { frequency: 'daily' as const };
		await storage.create({
			content: 'Task recur',
			project: 'Work',
			priority: 1,
			recurrence,
		});

		expect(spies.createReminder).toHaveBeenCalledWith('Work', 'Task recur', undefined, 1, recurrence);
	});

	it('falls back to the deterministic reminder id when optimistic state is unavailable', async () => {
		const index = createIndex();
		const { writer } = createWriter();
		const storage = createStorageCompat(index, writer);

		const created = await storage.create({
			content: 'Task B',
			project: 'Inbox',
			priority: 4,
		});

		expect(created.id).toBe(generateReminderId('Reminders/Inbox.md', 'Task B'));
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
});
