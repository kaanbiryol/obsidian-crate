import type { UpdateReminderInput } from '../../core/reminderMutationPlan';
import type { App, TFile } from "obsidian";
import type {
	Priority,
	RecurrenceRule,
} from "@/reminders/types/reminder";
import type { IndexedReminder, ReminderIndex } from "../reminder-index";
import type { ReminderMoveJournal } from '../reminder-move-journal';

export interface MarkdownWriterContext {
	app: App;
	index: ReminderIndex;
	moveJournal?: ReminderMoveJournal;
	getFile(filePath: string): Promise<TFile | null>;
	getOrCreateProjectFile(project: string): Promise<TFile>;
}

export interface CreateReminderInput {
	project: string;
	content: string;
	dueDate?: Date;
	priority: Priority;
	recurrence?: RecurrenceRule;
	hasTime?: boolean;
	reminderId?: string;
	description?: string;
}

export interface MarkdownWriter {
	createReminder(input: CreateReminderInput): Promise<void>;

	updateReminder(
		reminder: IndexedReminder,
		updates: UpdateReminderInput,
	): Promise<void>;

	deleteReminder(reminder: IndexedReminder): Promise<void>;

	toggleComplete(reminder: IndexedReminder): Promise<void>;

	reorderReminders(filePath: string, orderedIds: string[]): Promise<void>;
}
