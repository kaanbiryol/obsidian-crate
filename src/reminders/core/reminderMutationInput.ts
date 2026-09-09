import { normalizeReminderProjectPath } from './reminderProjectPath';

const REMINDER_TITLE_MAX_LENGTH = 1024;
const REMINDER_DESCRIPTION_MAX_LENGTH = 4096;

export class ReminderInputError extends Error {
	constructor(readonly field: string, message: string) {
		super(message);
		this.name = 'ReminderInputError';
	}
}

function invalid(field: string, message: string): never {
	throw new ReminderInputError(field, message);
}

function containsControl(value: string, multiline = false): boolean {
	return Array.from(value).some(character => {
		const code = character.codePointAt(0)!;
		return (code >= 0xd800 && code <= 0xdfff) || (code < 32 || code === 127) && !(multiline && [9, 10, 13].includes(code));
	});
}

function validDateKey(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Validate before normalization: omitted, explicitly cleared and invalid are distinct. */
export function assertReminderMutationInput(
	input: { content?: unknown; description?: unknown; project?: unknown; priority?: unknown; dueDate?: unknown; dueDatetime?: unknown },
	mode: 'create' | 'update',
): void {
	if (mode === 'create' || input.content !== undefined) {
		if (typeof input.content !== 'string' || !input.content.trim()) invalid('content', 'Enter a reminder title.');
		if (input.content.trim().length > REMINDER_TITLE_MAX_LENGTH) invalid('content', `Keep the reminder title within ${REMINDER_TITLE_MAX_LENGTH} characters.`);
		if (containsControl(input.content)) invalid('content', 'Keep the reminder title on one line without control characters.');
	}
	if (input.description !== undefined && input.description !== null) {
		if (typeof input.description !== 'string') invalid('description', 'Enter a text description or clear it.');
		if (input.description.trim().length > REMINDER_DESCRIPTION_MAX_LENGTH) invalid('description', `Keep the description within ${REMINDER_DESCRIPTION_MAX_LENGTH} characters.`);
		if (containsControl(input.description, true)) invalid('description', 'Remove unsupported control characters from the description.');
	}
	if (input.project !== undefined && input.project !== null && input.project !== '') {
		if (typeof input.project !== 'string' || containsControl(input.project) || !normalizeReminderProjectPath(input.project)) invalid('project', 'Enter a valid reminder project.');
	}
	if (input.priority !== undefined && input.priority !== 1 && input.priority !== 4) invalid('priority', 'Choose a valid reminder priority.');
	for (const field of ['dueDate', 'dueDatetime'] as const) {
		const value = input[field];
		if (value === undefined || value === null || value === '') continue;
		if (typeof value !== 'string' || !validDateKey(value.slice(0, 10))) invalid(field, 'Choose a valid reminder date.');
		if (field === 'dueDate' ? value.length !== 10
			: !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
			invalid(field, field === 'dueDate' ? 'Choose a date without a time.' : 'Choose a valid reminder time and timezone.');
		}
	}
}
