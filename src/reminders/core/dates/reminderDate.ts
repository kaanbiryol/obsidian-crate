const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENGLISH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Keep the precision that Chrono recognized when reconstructing editor text. */
export function formatReminderTime(hour: number, minute: number, second = 0, millisecond = 0): string {
	const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
	const seconds = second || millisecond ? `:${String(second).padStart(2, '0')}` : '';
	const fraction = millisecond ? `.${String(millisecond).padStart(3, '0')}` : '';
	return clock + seconds + fraction;
}

/** Fixed English syntax for the reminder parser, independent of the UI locale. */
export function formatReminderDateText(date: Date, hasTime = false): string {
	if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid time value');
	const year = date.getFullYear();
	const day = `${ENGLISH_MONTHS[date.getMonth()]} ${date.getDate()}, ${String(year > 0 ? year : 1 - year).padStart(4, '0')}`;
	if (!hasTime) return day;
	return `${day} ${formatReminderTime(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())}`;
}

const STORED_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A stored all-day date: `YYYY-MM-DD` naming a real calendar day. */
export function isStoredReminderDate(value: string): boolean {
	if (!DATE_ONLY_PATTERN.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** A stored instant: an ISO date and time with an explicit offset, on a real calendar day. */
export function isStoredReminderDatetime(value: string): boolean {
	return STORED_DATETIME_PATTERN.test(value) && isStoredReminderDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

export function isDateOnlyString(value: string | null | undefined): value is string {
	return !!value && DATE_ONLY_PATTERN.test(value);
}

/** YYYY-MM-DD from calendar components; month is 1-based. */
export function formatDateKeyParts(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatLocalDateKey(date: Date): string {
	return formatDateKeyParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function isReminderDueToday(input: {
	dueDate?: string;
	dueDatetime?: string;
}, now = new Date()): boolean {
	const todayKey = formatLocalDateKey(now);
	if (input.dueDatetime) {
		return formatLocalDateKey(new Date(input.dueDatetime)) === todayKey;
	}
	return input.dueDate === todayKey;
}

export function isReminderOverdue(input: {
	dueDate?: string;
	dueDatetime?: string;
	completed: boolean;
}, now = new Date()): boolean {
	if (input.completed) return false;
	if (input.dueDatetime) return new Date(input.dueDatetime) < now;
	return !!input.dueDate && input.dueDate < formatLocalDateKey(now);
}

export function parseLocalDateKey(value: string): Date {
	const match = DATE_ONLY_PATTERN.exec(value);
	if (!match) {
		throw new Error(`Invalid local date key: ${value}`);
	}

	const [, year, month, day] = match;
	const date = new Date(0);
	date.setFullYear(Number(year), Number(month) - 1, Number(day));
	date.setHours(0, 0, 0, 0);
	// Date constructors roll February 30 and month 13 into another valid day.
	return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1
		&& date.getDate() === Number(day) ? date : new Date(NaN);
}

export function inferHasTimeFromDate(date: Date | undefined): boolean {
	if (!date) {
		return false;
	}

	return (
		date.getHours() !== 0
		|| date.getMinutes() !== 0
		|| date.getSeconds() !== 0
		|| date.getMilliseconds() !== 0
	);
}

export function parseReminderDateValue(
	value: string | null | undefined,
	hasTime?: boolean,
): Date | undefined {
	if (!value) {
		return undefined;
	}

	const resolvedHasTime = hasTime ?? !isDateOnlyString(value);
	return resolvedHasTime ? new Date(value) : parseLocalDateKey(value);
}

export function parseStoredReminderDate(input: {
	dueDate?: string;
	dueDatetime?: string;
}): Date | undefined {
	if (input.dueDatetime) {
		return new Date(input.dueDatetime);
	}

	return parseReminderDateValue(input.dueDate, false);
}

export function reminderHasTime(input: {
	dueDate?: string;
	dueDatetime?: string;
}): boolean | undefined {
	if (input.dueDatetime) {
		return true;
	}
	if (input.dueDate) {
		return false;
	}
	return undefined;
}

export function serializeReminderDateValue(
	date: Date | undefined,
	hasTime?: boolean,
): string | undefined {
	if (!date) {
		return undefined;
	}

	const resolvedHasTime = hasTime ?? inferHasTimeFromDate(date);
	return resolvedHasTime ? date.toISOString() : formatLocalDateKey(date);
}

export function buildStoredReminderDates(
	date: Date | undefined,
	hasTime?: boolean,
): { dueDate?: string; dueDatetime?: string } {
	if (!date) {
		return {};
	}

	const resolvedHasTime = hasTime ?? inferHasTimeFromDate(date);
	return {
		dueDate: resolvedHasTime ? date.toISOString().slice(0, 10) : formatLocalDateKey(date),
		dueDatetime: resolvedHasTime ? date.toISOString() : undefined,
	};
}
