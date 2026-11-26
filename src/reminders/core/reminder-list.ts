/**
 * Builds the reminder list from parsed source files. The Worker index and the
 * encrypted web app apply this one rule, so both show the same reminders,
 * projects and source issues for the same notes.
 */

export const REMINDER_IDENTITY_CONFLICT_ISSUE = 'Duplicate reminder identifiers. Open the affected notes in Obsidian to assign unique identifiers before editing or scheduling them.';

/** Notes with a duplicate identity a client may name in a reminder list delta request.
 * With more, the client reads the full list. */
export const MAX_DELTA_CONFLICT_NOTES = 20;
/** Characters the named notes may add to a delta request's URL, encoded, which keeps long
 * or non-Latin paths well within URL limits. With more, the client reads the full list. */
export const MAX_DELTA_CONFLICT_QUERY_CHARS = 4096;

/** A note whose reminders are left out of the list, and why. */
export interface ReminderSourceIssue {
	path: string;
	reason: string;
}

interface ReminderListSource<R> {
	/** The path issues report, as the client sees it. */
	path: string;
	project: string;
	reminders: readonly R[];
	issue?: string;
}

/** A project's reminder IDs in list order. Lists keep each note's reminders in
 * file order, so this matches the order a reorder command checks against. */
export function projectReminderOrder(reminders: readonly { id: string; project: string }[], project: string): string[] {
	return reminders.filter(reminder => reminder.project === project).map(reminder => reminder.id);
}

export function compareProjects(left: string, right: string): number {
	return left.localeCompare(right);
}

/** Every copy of a duplicated reminder ID is hidden, and each affected file
 * reports one issue. A file's own issue takes precedence over the conflict.
 * `counts`, when given, holds each ID's copies in the whole folder, so a subset of
 * its notes gets the reminders and issues it has in the full list. */
export function buildReminderList<R extends { id: string }>(sources: readonly ReminderListSource<R>[], counts?: ReadonlyMap<string, number>): {
	reminders: R[];
	projects: string[];
	issues: ReminderSourceIssue[];
} {
	const totals = counts ?? sources.reduce((counted, source) => {
		for (const reminder of source.reminders) counted.set(reminder.id, (counted.get(reminder.id) ?? 0) + 1);
		return counted;
	}, new Map<string, number>());
	const reminders: R[] = [], issues: ReminderSourceIssue[] = [], projects = new Set<string>();
	for (const source of sources) {
		projects.add(source.project);
		const unique = source.reminders.filter(reminder => totals.get(reminder.id) === 1);
		reminders.push(...unique);
		const reason = source.issue ?? (unique.length < source.reminders.length ? REMINDER_IDENTITY_CONFLICT_ISSUE : undefined);
		if (reason) issues.push({ path: source.path, reason });
	}
	return { reminders, projects: [...projects].sort(compareProjects), issues };
}
