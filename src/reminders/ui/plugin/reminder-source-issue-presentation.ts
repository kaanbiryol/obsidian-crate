import type { ReminderSourceIssue } from '../../data/reminder-source-issues';

/** Keep scanner diagnostics intact; translate their known messages only for display. */
export function presentReminderSourceIssues(issues: readonly ReminderSourceIssue[]) {
	const filename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
	const counts = new Map<string, number>();
	for (const issue of issues) {
		const name = filename(issue.path).toLowerCase();
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return issues.map(issue => {
		const name = filename(issue.path);
		const label = counts.get(name.toLowerCase())! > 1 ? issue.path : name;
		const descriptionError = /^(Invalid reminder description (?:block|encoding)|Unsupported reminder description encoding)(?: on line ([1-9]\d*))?\.?$/.exec(issue.reason);
		const line = descriptionError?.[2];
		let title = 'Couldn’t refresh reminders';
		let description = issue.reason;
		if (descriptionError) {
			title = 'Couldn’t read one reminder';
			description = descriptionError[1]?.startsWith('Unsupported')
				? 'This reminder’s description uses an unsupported format.'
				: 'This reminder has an invalid description.';
		} else if (issue.reason.startsWith('Save this note as UTF-8 without null characters')) {
			title = 'Couldn’t read this note';
			description = 'Save this note as UTF-8 text without null characters.';
		}
		return { ...issue, title, description, location: line ? `${label} · line ${line}` : label };
	});
}
