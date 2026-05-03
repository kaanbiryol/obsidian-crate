import { parseCheckboxLine, generateContentHash } from '@/reminders/utils/checkboxParser';
import { buildStoredReminderDates } from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { getProjectColor } from '@/reminders/utils/projectColors';
import type { RemoteReminderRecord } from './types';

export function getProjectFromPath(filePath: string, remindersFolderPath: string): string {
	const normalizedFile = filePath.toLowerCase();
	const normalizedFolder = remindersFolderPath.replace(/^\/|\/$/g, '').toLowerCase();

	let relativePath = filePath;
	if (normalizedFile.startsWith(normalizedFolder + '/')) {
		relativePath = filePath.slice(remindersFolderPath.length + 1);
	}

	if (relativePath.toLowerCase().endsWith('.md')) {
		relativePath = relativePath.slice(0, -3);
	}

	return relativePath || 'Inbox';
}

export function scanReminderMarkdownFile(filePath: string, content: string, remindersFolderPath: string): RemoteReminderRecord[] {
	const reminders: RemoteReminderRecord[] = [];
	const project = getProjectFromPath(filePath, remindersFolderPath);
	const lines = content.split('\n');

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber];
		const parsed = parseCheckboxLine(line);
		if (!parsed || !parsed.parsed.cleanContent.trim() || !parsed.reminderId) {
			continue;
		}

		const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
		let description: string | undefined;
		let descBlockLineCount = 0;
		const nextIndex = lineNumber + 1;
		if (nextIndex < lines.length && lines[nextIndex].startsWith('<!-- crate-desc:')) {
			let descContent = lines[nextIndex].slice('<!-- crate-desc:'.length);
			let endIndex = nextIndex;
			while (endIndex < lines.length) {
				const source = endIndex === nextIndex ? descContent : lines[endIndex];
				const closingPos = source.indexOf('-->');
				if (closingPos !== -1) {
					if (endIndex === nextIndex) {
						descContent = descContent.slice(0, closingPos).trimEnd();
					} else {
						descContent += '\n' + lines[endIndex].slice(0, closingPos).trimEnd();
					}
					descBlockLineCount = endIndex - nextIndex + 1;
					break;
				}
				if (endIndex > nextIndex) {
					descContent += '\n' + lines[endIndex];
				}
				endIndex++;
			}
			description = descContent.trim() || undefined;
		}

		reminders.push({
			id: parsed.reminderId,
			content: parsed.parsed.cleanContent,
			description,
			dueDate: storedDates.dueDate,
			dueDatetime: storedDates.dueDatetime,
			priority: parsed.parsed.priority,
			completed: parsed.isCompleted,
			project,
			recurrence: normalizeRecurrenceRule(parsed.parsed.recurrence),
			filePath,
			lineNumber,
			rawLine: line,
			contentHash: generateContentHash(parsed.rawContent),
		});

		if (descBlockLineCount > 0) {
			lineNumber = nextIndex + descBlockLineCount - 1;
		}
	}

	return reminders;
}

export function toReminderPayload(reminder: RemoteReminderRecord): Record<string, unknown> {
	return {
		id: reminder.id,
		content: reminder.content,
		description: reminder.description,
		dueDate: reminder.dueDate,
		dueDatetime: reminder.dueDatetime,
		priority: reminder.priority,
		completed: reminder.completed,
		project: reminder.project,
		recurrence: reminder.recurrence,
		filePath: reminder.filePath,
		lineNumber: reminder.lineNumber,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		projectColor: getProjectColor(reminder.project),
	};
}
