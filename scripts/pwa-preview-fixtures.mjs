import { randomUUID } from 'node:crypto';

export const previewAuthToken = 'preview-auth-token';
export const previewEnrollmentToken = 'preview-install-token';

function daysFromNow(days, hour = 9, minute = 0) {
	const next = new Date();
	next.setHours(hour, minute, 0, 0);
	next.setDate(next.getDate() + days);
	return next.toISOString();
}

export function createInitialState() {
	return {
		reminders: [
			{
				id: 'preview-inbox-1',
				content: 'Check this article',
				description: '',
				dueDate: undefined,
				dueDatetime: undefined,
				priority: 4,
				completed: false,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
			},
			{
				id: 'preview-inbox-2',
				content: 'Tighten the PWA layout',
				description: 'Reduce vertical chrome, fix card spacing, and make the sheet feel native on iPhone.',
				dueDate: undefined,
				dueDatetime: undefined,
				priority: 4,
				completed: false,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
			},
			{
				id: 'preview-work-1',
				content: 'Do I have this documented already?',
				description: 'Reducing project generation time was called out as a major issue in the last review.',
				dueDate: undefined,
				dueDatetime: daysFromNow(-1, 10, 30),
				priority: 4,
				completed: false,
				project: 'Work',
				filePath: 'Reminders/Work.md',
			},
			{
				id: 'preview-work-2',
				content: "Fix your ADR's Bazel section",
				description: 'Pull a few CI numbers so the note has a concrete performance comparison.',
				dueDate: undefined,
				dueDatetime: daysFromNow(0, 12, 0),
				priority: 4,
				completed: false,
				project: 'Work',
				filePath: 'Reminders/Work.md',
			},
			{
				id: 'preview-personal-1',
				content: 'Call the dentist',
				description: '',
				dueDate: undefined,
				dueDatetime: daysFromNow(2, 15, 0),
				priority: 4,
				completed: false,
				project: 'Personal',
				filePath: 'Reminders/Personal.md',
			},
			{
				id: 'preview-work-3',
				content: 'Archive old reminder copy',
				description: 'Completed items should stay below active ones.',
				dueDate: undefined,
				dueDatetime: daysFromNow(-2, 8, 0),
				priority: 4,
				completed: true,
				project: 'Work',
				filePath: 'Reminders/Work.md',
			},
		],
	};
}

export function normalizeProject(project) {
	const trimmed = String(project || '').trim();
	return trimmed || 'Inbox';
}

export function applyProjectFilePath(reminder) {
	return {
		...reminder,
		project: normalizeProject(reminder.project),
		filePath: `Reminders/${normalizeProject(reminder.project)}.md`,
	};
}

export function sortForList(reminders) {
	return reminders.map(applyProjectFilePath);
}

export function projectNames(reminders) {
	return Array.from(new Set(reminders.map((reminder) => normalizeProject(reminder.project)))).sort((a, b) => a.localeCompare(b));
}

export function findReminder(state, id) {
	return state.reminders.find((reminder) => reminder.id === id);
}

export function parseMutationReminder(body) {
	const project = normalizeProject(body.project);
	return applyProjectFilePath({
		id: body.id || randomUUID(),
		content: String(body.content || '').trim(),
		description: body.description ? String(body.description) : '',
		dueDate: body.dueDate || undefined,
		dueDatetime: body.dueDatetime || undefined,
		priority: Number.parseInt(String(body.priority || '4'), 10) === 1 ? 1 : 4,
		completed: Boolean(body.completed),
		project,
		filePath: `Reminders/${project}.md`,
	});
}
