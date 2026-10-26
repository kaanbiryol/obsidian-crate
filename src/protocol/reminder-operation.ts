export const REMINDER_RETRY_DAYS = 180;
/** Versioned operation IDs: this tag, the creation day as 8 digits, `_`, then a random part. */
export const OPERATION_ID_TAG = 'e1_';
const DATED_OPERATION_ID = new RegExp(`^${OPERATION_ID_TAG}(\\d{8})_[a-zA-Z0-9_-]{16,100}$`);

/** Client-chosen idempotency key shared by the PWA outbox and Worker reminder routes. */
export function isReminderOperationId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}

export function reminderOperationDay(id: string): number | null {
	const match = DATED_OPERATION_ID.exec(id);
	return match ? Number(match[1]) : null;
}

export function createReminderOperationId(day: number): string {
	if (!Number.isInteger(day) || day < 1 || day > 99_999_999) throw new Error('Invalid reminder operation day');
	return `${OPERATION_ID_TAG}${String(day).padStart(8, '0')}_${crypto.randomUUID()}`;
}
