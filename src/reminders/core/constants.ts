/**
 * Shared constants used across the plugin
 */

/**
 * Default project name for reminders without a project
 */
export const DEFAULT_PROJECT = 'Inbox';

/** Reminder notes larger than this are reported as issues instead of parsed,
 * and web app edits cannot read or grow a note past it. */
export const MAX_REMINDER_NOTE_BYTES = 1024 * 1024;

/** Shown for a note over that limit wherever its reminders are listed. The Worker
 * persists this text and recovers its sync issue code by exact match. */
export const REMINDER_NOTE_SIZE_ISSUE = 'Split this note into files of 1 MiB or smaller to use its reminders. The vault file remains synced.';

/** Most reminders one note can reorder or publish as encrypted schedules. */
export const MAX_REMINDERS_PER_NOTE = 10_000;

/** Project choices with the default project first. */
export function projectOptionsWithDefault(projects: readonly string[]): string[] {
	return [DEFAULT_PROJECT, ...projects.filter(project => project !== DEFAULT_PROJECT)];
}
