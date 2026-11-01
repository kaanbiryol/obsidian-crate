import type { Reminder } from "@/reminders/types/reminder";
import { normalizeRecurrenceRule } from "./recurrence/recurrenceRule";
import { reminderProject } from "./reminderProjectPath";

type ReminderSource = Omit<Reminder, "project"> & { project?: string | null };

/** Convert a parsed reminder, from the plugin index or a web app record, into the UI-facing reminder model. */
export function toReminder(source: ReminderSource): Reminder {
	return {
		id: source.id,
		content: source.content,
		description: source.description,
		dueDate: source.dueDate,
		dueDatetime: source.dueDatetime,
		priority: source.priority,
		completed: source.completed,
		project: reminderProject(source),
		recurrence: normalizeRecurrenceRule(source.recurrence),
		lineNumber: source.lineNumber,
	};
}
