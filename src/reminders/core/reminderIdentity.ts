// The marker belongs at the line end, but edits can push text after it or join
// another line on; it still names the reminder and the next write moves it back.
// Leading whitespace is trimmed in code: a pattern starting with \s* backtracks
// quadratically over long whitespace runs.
const REMINDER_ID_MARKERS_REGEX = /<!--\s*crate-id:([A-Za-z0-9_-]+)\s*-->/g;

function reminderIdMarkers(value: string) {
	return [...value.matchAll(REMINDER_ID_MARKERS_REGEX)].map(match => {
		let from = match.index;
		while (from > 0 && /\s/.test(value[from - 1]!)) from--;
		return { from, to: match.index + match[0].length, id: match[1] ?? '' };
	});
}

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
	const [marker] = reminderIdMarkers(value);
	if (!marker) {
		return null;
	}

	return normalizeReminderId(marker.id) ?? null;
}

/** The first marker's span, including the whitespace before it. */
export function findReminderIdMarker(value: string): { from: number; to: number } | null {
	const [marker] = reminderIdMarkers(value);
	return marker ? { from: marker.from, to: marker.to } : null;
}

export function stripReminderIdMarker(value: string): string {
	let stripped = '', end = 0;
	for (const { from, to } of reminderIdMarkers(value)) {
		stripped += value.slice(end, Math.max(from, end));
		end = to;
	}
	return (stripped + value.slice(end)).trimEnd();
}

export function setReminderIdMarker(value: string, reminderId: string): string {
	const normalizedReminderId = normalizeReminderId(reminderId);
	if (!normalizedReminderId) {
		throw new Error('Reminder ID is invalid');
	}

	// Keep a CRLF line's carriage return, which trimming the old marker removes.
	return `${stripReminderIdMarker(value)} <!-- crate-id:${normalizedReminderId} -->${value.endsWith('\r') ? '\r' : ''}`;
}
