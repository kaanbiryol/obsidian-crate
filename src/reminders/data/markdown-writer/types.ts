import type { App, TFile } from "obsidian";
import type {
  Priority,
  RecurrenceRule,
} from "@/reminders/types/reminder";
import type { IndexedReminder, ReminderIndex } from "../reminder-index";
import type { ReminderMoveJournal } from '../reminder-move-journal';

export interface UpdateReminderInput {
  content?: string;
  description?: string;
  dueDate?: Date;
  priority?: Priority;
  project?: string;
  recurrence?: RecurrenceRule | null;
  hasTime?: boolean;
}

export type OnFileWrittenCallback = (file: TFile) => Promise<void>;

export interface MarkdownWriterContext {
  app: App;
  index: ReminderIndex;
  moveJournal?: ReminderMoveJournal;
  getFile(filePath: string): Promise<TFile | null>;
  getOrCreateProjectFile(project: string): Promise<TFile>;
  getOnFileWritten(): OnFileWrittenCallback | undefined;
}

export interface MarkdownWriter {
  createReminder(
    project: string,
    content: string,
    dueDate: Date | undefined,
    priority: Priority,
    recurrence?: RecurrenceRule,
    hasTime?: boolean,
    reminderId?: string,
    description?: string,
  ): Promise<void>;

  updateReminder(
    reminder: IndexedReminder,
    updates: UpdateReminderInput,
  ): Promise<void>;

  deleteReminder(reminder: IndexedReminder): Promise<void>;

  toggleComplete(reminder: IndexedReminder): Promise<void>;

  reorderReminders(filePath: string, orderedIds: string[]): Promise<void>;

  setOnFileWritten(callback: OnFileWrittenCallback): void;
}
