import type { ReminderSourceIssue } from '../../data/reminder-source-issues';

/** Keep diagnostic copy separate from the parser's error category and location. */
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
		const diagnostic = issue.diagnostic;
		const line = diagnostic && 'line' in diagnostic ? diagnostic.line : undefined;
		let title = 'Couldn’t refresh reminders';
		let description = issue.reason;
		if (diagnostic?.code === 'invalid-markdown-encoding') {
			title = 'Couldn’t read this note';
			description = 'Save this note as UTF-8 text without null characters.';
		} else if (diagnostic) {
			title = 'Couldn’t read one reminder';
			description = diagnostic.code === 'unsupported-description-encoding'
				? 'This reminder’s description uses an unsupported format.'
				: 'This reminder has an invalid description.';
		}
		return { ...issue, title, description, location: line ? `${label} · line ${line}` : label };
	});
}
