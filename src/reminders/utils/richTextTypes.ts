import type { ReminderSchedule } from './reminderSchedule';

export interface TextMatch {
    text: string;
    index: number;
    length: number;
    type: 'priority' | 'date' | 'project' | 'link';
    invalid?: boolean;
    error?: string;
    linkText?: string;
    linkUrl?: string;
    schedule?: ReminderSchedule;
}
