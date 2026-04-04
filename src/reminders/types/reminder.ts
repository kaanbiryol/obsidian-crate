export type Priority = 1 | 4;

// Recurrence types
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval?: number;           // every N days/weeks/months (default: 1)
  daysOfWeek?: number[];       // 0=Sun, 1=Mon...6=Sat (for weekly)
  dayOfMonth?: number;         // 1-31 (for monthly)
  endDate?: string;            // optional end date (ISO string)
  count?: number;              // optional max occurrences
  hour?: number;               // 0-23, time of day for recurring reminder
  minute?: number;             // 0-59, time of day for recurring reminder
  timezone?: string;           // IANA timezone for local wall-clock recurrence semantics
}

export interface Reminder {
  id: string; // Unique identifier for the reminder
  content: string;
  dueDate?: string; // ISO date string
  dueDatetime?: string; // ISO datetime string
  priority: Priority;
  completed: boolean;
  project?: string; // Project tag for organizing reminders (defaults to "Inbox")
  fileLink?: string; // Link to the markdown file where this reminder was created
  createdAt: string; // ISO datetime string
  updatedAt: string; // ISO datetime string
  completedAt?: string; // ISO datetime string when completed
  recurrence?: RecurrenceRule; // Optional recurrence rule for recurring reminders
}

export interface CreateReminderParams {
  content: string;
  dueDate?: string;
  dueDatetime?: string;
  priority?: Priority;
  project?: string; // Project tag (defaults to "Inbox")
  fileLink?: string; // Link to the markdown file where this reminder was created
  id?: string; // Optional: specify custom ID
  recurrence?: RecurrenceRule; // Optional recurrence rule
}

export interface UpdateReminderParams {
  content?: string;
  dueDate?: string;
  dueDatetime?: string;
  priority?: Priority;
  completed?: boolean;
  completedAt?: string;
  project?: string; // Project tag
  recurrence?: RecurrenceRule | null; // Optional recurrence rule (null to remove)
}
