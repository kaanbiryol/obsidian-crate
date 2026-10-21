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

/** Project choices with the default project first. */
export function projectOptionsWithDefault(projects: readonly string[]): string[] {
  return [DEFAULT_PROJECT, ...projects.filter(project => project !== DEFAULT_PROJECT)];
}
