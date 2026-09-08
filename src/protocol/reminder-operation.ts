export const REMINDER_RETRY_DAYS = 180;

export function reminderOperationDay(id: string): number | null {
	const match = /^e1_(\d{8})_[a-zA-Z0-9_-]{16,100}$/.exec(id);
	return match ? Number(match[1]) : null;
}

export function createReminderOperationId(day: number): string {
	if (!Number.isInteger(day) || day < 1 || day > 99_999_999) throw new Error('Invalid reminder operation day');
	return `e1_${String(day).padStart(8, '0')}_${crypto.randomUUID()}`;
}
