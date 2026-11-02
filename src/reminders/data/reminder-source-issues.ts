import { ReminderDescriptionError } from '../core/reminderDescription';
import { MarkdownEncodingError } from '../core/markdownEncoding';
import type { ReminderSourceIssue as ListedReminderSourceIssue } from '../core/reminder-list';

type ReminderSourceDiagnostic =
	| { code: ReminderDescriptionError['code']; line?: number }
	| { code: 'invalid-markdown-encoding' };

export interface ReminderSourceIssue extends ListedReminderSourceIssue {
	diagnostic?: ReminderSourceDiagnostic;
}

/** Retain structured local diagnostics before the scanner flattens an error. */
export function reminderSourceDiagnostic(error: unknown): ReminderSourceDiagnostic | undefined {
	if (error instanceof ReminderDescriptionError) {
		return { code: error.code, ...(error.line === undefined ? {} : { line: error.line }) };
	}
	if (error instanceof MarkdownEncodingError) return { code: 'invalid-markdown-encoding' };
	return undefined;
}
