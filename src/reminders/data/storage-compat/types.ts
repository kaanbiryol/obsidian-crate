import type { MarkdownWriter } from "../markdown-writer";
import type { ReminderIndex } from "../reminder-index";
import type { CreateReminderParams, Reminder, UpdateReminderParams } from "@/reminders/types/plugin-reminder";

export interface StorageCompat {
  getAll(): Reminder[];
  getActive(): Reminder[];
  getCompleted(): Reminder[];
  getTodayReminders(includeCompleted?: boolean): Reminder[];
  getUpcoming(days?: number): Reminder[];
  getOverdue(): Reminder[];
  getByProject(project: string): Reminder[];
  getByFile(filePath: string): Reminder[];
  getById(id: string): Reminder | undefined;
  getByIdAsync(id: string): Promise<Reminder | undefined>;
  getProjects(): string[];

  create(params: CreateReminderParams): Promise<Reminder>;
  update(id: string, params: UpdateReminderParams): Promise<Reminder | undefined>;
  delete(id: string): Promise<boolean>;
  complete(id: string): Promise<Reminder | undefined>;
  uncomplete(id: string): Promise<Reminder | undefined>;
  reorder(project: string, orderedIds: string[]): Promise<void>;

  forceSave(): Promise<void>;
  getStats(): { activeCount: number; completedCount: number; totalCount: number };
}

export interface StorageCompatContext {
  index: ReminderIndex;
  writer: MarkdownWriter;
}
