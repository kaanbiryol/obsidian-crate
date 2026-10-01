export type ReminderListStyle = 'cards' | 'flat';

export const DEFAULT_REMINDER_LIST_STYLE: ReminderListStyle = 'flat';

export function normalizeReminderListStyle(value: unknown): ReminderListStyle {
    return value === 'cards' || value === 'flat' ? value : DEFAULT_REMINDER_LIST_STYLE;
}
