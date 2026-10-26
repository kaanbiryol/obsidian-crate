import { reminderRevision } from '../core/reminderRevision';
import { createReminderId } from "../core/reminderIdentity";
import { buildCreateReminderArgs, buildReminderUpdate } from "../core/reminderMutationPlan";
import { selectTodayReminders } from "../core/reminderSort";
import type { CreateReminderParams, Reminder, UpdateReminderParams } from "@/reminders/types/reminder";
import { getReminderProjectFilePath } from "@/reminders/core/reminderProjectPath";
import type { MarkdownWriter } from "./markdown-writer";
import type { IndexedReminder, ReminderIndex } from "./reminder-index";
import { toReminder } from "./toReminder";

export interface ReminderRepository {
	getAll(): Reminder[];
	getActive(): Reminder[];
	getTodayReminders(includeCompleted?: boolean): Reminder[];
	getProjects(): string[];

	create(params: CreateReminderParams): Promise<Reminder>;
	update(id: string, params: UpdateReminderParams): Promise<Reminder | undefined>;
	delete(id: string, expectedRevision?: string): Promise<boolean>;
	complete(id: string): Promise<Reminder | undefined>;
	uncomplete(id: string): Promise<Reminder | undefined>;
	reorder(project: string, orderedIds: string[]): Promise<void>;
}

interface ReminderRepositoryContext {
	index: ReminderIndex;
	writer: MarkdownWriter;
}

export function createReminderRepository(
	index: ReminderIndex,
	writer: MarkdownWriter
): ReminderRepository {
	const context = { index, writer };
	return {
		...createReminderRepositoryQueries(context),
		...createReminderRepositoryMutations(context),
	};
}

/** Converted reminders keep their identity while the indexed record is
 * unchanged, so memoized rows skip rendering after edits to other notes. The
 * index can update a record in place (a file move), so fields are compared too. */
const CONVERTED_FIELDS = ['id', 'content', 'description', 'dueDate', 'dueDatetime', 'priority', 'completed', 'project', 'recurrence', 'lineNumber'] as const;

function createReminderRepositoryQueries({ index }: ReminderRepositoryContext) {
	const converted = new WeakMap<IndexedReminder, { source: Pick<IndexedReminder, typeof CONVERTED_FIELDS[number]>; reminder: Reminder }>();
	const convert = (indexed: IndexedReminder): Reminder => {
		const cached = converted.get(indexed);
		if (cached && CONVERTED_FIELDS.every(field => cached.source[field] === indexed[field])) return cached.reminder;
		const reminder = toReminder(indexed);
		converted.set(indexed, { source: Object.fromEntries(CONVERTED_FIELDS.map(field => [field, indexed[field]])) as Pick<IndexedReminder, typeof CONVERTED_FIELDS[number]>, reminder });
		return reminder;
	};
	return {
		getAll() {
			return index.getAll().map(convert);
		},

		getActive() {
			return index.getActive().map(convert);
		},

		getTodayReminders(includeCompleted = false) {
			// Read the clock before the index so the query reflects the moment it was requested.
			const now = new Date();
			return selectTodayReminders(index.getAll(), now, includeCompleted).map(convert);
		},

		getProjects() {
			return index.getProjects();
		},
	};
}

function createReminderRepositoryMutations({ index, writer }: ReminderRepositoryContext) {
	const currentReminder = (id: string) => {
		const current = index.getById(id);
		return current ? toReminder(current) : undefined;
	};
	return {
		async create(params: CreateReminderParams) {
			const createArgs = buildCreateReminderArgs(params);
			const reminderId = createArgs.reminderId || createReminderId();

			await writer.createReminder({
				project: createArgs.project,
				content: params.content,
				dueDate: createArgs.dueDate,
				priority: createArgs.priority,
				recurrence: createArgs.recurrence,
				hasTime: createArgs.hasTime,
				reminderId,
				description: params.description,
			});

			const createdReminder = index.getById(reminderId);
			// The note was written, but its line did not read back as this reminder.
			if (!createdReminder) throw new Error('The reminder was saved to its note but could not be read back. Open the note and remove date, repeat or priority text from its title.');
			return toReminder(createdReminder);
		},

		async update(id: string, params: UpdateReminderParams) {
			const indexed = index.getById(id);
			if (!indexed) return undefined;

			if (params.expectedRevision && params.expectedRevision !== await reminderRevision(toReminder(indexed))) throw new Error('Reminder changed while editing. Your draft was not saved.');
			await writer.updateReminder(indexed, buildReminderUpdate(params));

			return currentReminder(id);
		},

		async delete(id: string, expectedRevision?: string) {
			const indexed = index.getById(id);
			if (!indexed) return false;

			if (expectedRevision && expectedRevision !== await reminderRevision(toReminder(indexed))) throw new Error('Reminder changed while editing. Nothing was deleted.');
			await writer.deleteReminder(indexed);
			return true;
		},

		async complete(id: string) {
			const indexed = index.getById(id);
			if (!indexed) return undefined;

			if (!indexed.completed) {
				await writer.toggleComplete(indexed);
			}

			return currentReminder(id);
		},

		async uncomplete(id: string) {
			const indexed = index.getById(id);
			if (!indexed) return undefined;

			if (indexed.completed) {
				await writer.toggleComplete(indexed);
			}

			return currentReminder(id);
		},

		async reorder(project: string, orderedIds: string[]) {
			const filePath = getReminderProjectFilePath(index.remindersFolderPath, project);
			await writer.reorderReminders(filePath, orderedIds);
		},
	};
}
