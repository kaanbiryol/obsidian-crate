/**
 * Builds the reminder list from parsed source files. The Worker index and the
 * encrypted web app apply this one rule, so both show the same reminders,
 * projects and source issues for the same notes.
 */

export const REMINDER_IDENTITY_CONFLICT_ISSUE = 'Duplicate reminder identifiers. Open the affected notes in Obsidian to assign unique identifiers before editing or scheduling them.';

interface ReminderListSource<R> {
	/** The path issues report, as the client sees it. */
	path: string;
	project: string;
	reminders: readonly R[];
	issue?: string;
}

export function compareProjects(left: string, right: string): number {
	return left.localeCompare(right);
}

/** Every copy of a duplicated reminder ID is hidden, and each affected file
 * reports one issue. A file's own issue takes precedence over the conflict. */
export function buildReminderList<R extends { id: string }>(sources: readonly ReminderListSource<R>[]): {
	reminders: R[];
	projects: string[];
	issues: Array<{ path: string; reason: string }>;
} {
	const counts = new Map<string, number>();
	for (const source of sources) for (const reminder of source.reminders) counts.set(reminder.id, (counts.get(reminder.id) ?? 0) + 1);
	const reminders: R[] = [], issues: Array<{ path: string; reason: string }> = [], projects = new Set<string>();
	for (const source of sources) {
		projects.add(source.project);
		const unique = source.reminders.filter(reminder => counts.get(reminder.id) === 1);
		reminders.push(...unique);
		const reason = source.issue ?? (unique.length < source.reminders.length ? REMINDER_IDENTITY_CONFLICT_ISSUE : undefined);
		if (reason) issues.push({ path: source.path, reason });
	}
	return { reminders, projects: [...projects].sort(compareProjects), issues };
}
