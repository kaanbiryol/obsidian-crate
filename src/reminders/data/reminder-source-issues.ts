import { ReminderDescriptionError } from '../core/reminderDescription';
import { MarkdownEncodingError } from '../core/markdownEncoding';

type ReminderSourceDiagnostic =
	| { code: ReminderDescriptionError['code']; line?: number }
	| { code: 'invalid-markdown-encoding' };

export interface ReminderSourceIssue {
	path: string;
	reason: string;
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
