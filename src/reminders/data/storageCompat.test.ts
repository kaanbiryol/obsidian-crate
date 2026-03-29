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

function createWriter(): MarkdownWriter {
	return {
		createReminder: vi.fn(async () => {}),
		updateReminder: vi.fn(async () => {}),
		deleteReminder: vi.fn(async () => {}),
		toggleComplete: vi.fn(async () => {}),
		setOnReminderChange: vi.fn(),
		setOnFileWritten: vi.fn(),
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
		const writer = createWriter();
		const storage = createStorageCompat(index, writer);

		const created = await storage.create({
			content: 'Task A',
			project: 'Work',
			priority: 1,
		});

		expect(created.id).toBe(reminderId);
		expect(created.content).toBe('Task A');
		expect(writer.createReminder).toHaveBeenCalledWith('Work', 'Task A', undefined, 1);
	});

	it('falls back to the deterministic reminder id when optimistic state is unavailable', async () => {
		const index = createIndex();
		const writer = createWriter();
		const storage = createStorageCompat(index, writer);

		const created = await storage.create({
			content: 'Task B',
			project: 'Inbox',
			priority: 4,
		});

		expect(created.id).toBe(generateReminderId('Reminders/Inbox.md', 'Task B'));
	});
});
