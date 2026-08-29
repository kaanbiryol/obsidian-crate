import type { MarkdownWriter } from "../markdown-writer";
import type { ReminderIndex } from "../reminder-index";
import type { CreateReminderParams, Reminder, UpdateReminderParams } from "@/reminders/types/plugin-reminder";

export interface ReminderRepository {
  getAll(): Reminder[];
  getActive(): Reminder[];
  getTodayReminders(includeCompleted?: boolean): Reminder[];
  getProjects(): string[];

  create(params: CreateReminderParams): Promise<Reminder>;
  update(id: string, params: UpdateReminderParams): Promise<Reminder | undefined>;
  delete(id: string): Promise<boolean>;
  complete(id: string): Promise<Reminder | undefined>;
  uncomplete(id: string): Promise<Reminder | undefined>;
  reorder(project: string, orderedIds: string[]): Promise<void>;

  getStats(): { activeCount: number; completedCount: number; totalCount: number };
}

export interface ReminderRepositoryContext {
  index: ReminderIndex;
  writer: MarkdownWriter;
}
