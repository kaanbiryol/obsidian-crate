const REMINDER_ID_MARKER_REGEX = /\s*<!--\s*crate-id:([A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*)\s*-->\s*$/;

function normalizeReminderId(id: string): string | null {
	const trimmed = id.trim();
	if (!trimmed || /\s/.test(trimmed)) {
		return null;
	}

	return trimmed;
}

export function createReminderId(): string {
	return crypto.randomUUID();
}

export function extractReminderId(value: string): string | null {
	const match = value.match(REMINDER_ID_MARKER_REGEX);
	if (!match) {
		return null;
	}

	return normalizeReminderId(match[1] ?? '') ?? null;
}

export function stripReminderIdMarker(value: string): string {
	return value.replace(REMINDER_ID_MARKER_REGEX, '').trimEnd();
}

export function setReminderIdMarker(value: string, reminderId: string): string {
	const normalizedReminderId = normalizeReminderId(reminderId);
	if (!normalizedReminderId) {
		throw new Error('Reminder ID is invalid');
	}

	return `${stripReminderIdMarker(value)} <!-- crate-id:${normalizedReminderId} -->`;
}
