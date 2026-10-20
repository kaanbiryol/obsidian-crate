/**
 * Shared constants used across the plugin
 */

/**
 * Default project name for reminders without a project
 */
export const DEFAULT_PROJECT = 'Inbox';

/** Project choices with the default project first. */
export function projectOptionsWithDefault(projects: readonly string[]): string[] {
  return [DEFAULT_PROJECT, ...projects.filter(project => project !== DEFAULT_PROJECT)];
}
