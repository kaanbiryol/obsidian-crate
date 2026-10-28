import type { SyncIssue } from '../../sync/types';
import type { SyncIssueCode } from '../../protocol/sync-issues';
import { syncConnectionFailureMessage } from '../settings/infrastructure/self-hosted-errors';

interface IssueExplanation { summary: string; recovery: string }

const MORE_REMINDER_ISSUES: IssueExplanation = {
	summary: 'More reminder notes need attention.',
	recovery: 'Repair the listed notes, then sync again to review the remaining files.',
};
const UNSUPPORTED_DESCRIPTION: IssueExplanation = {
	summary: 'A reminder description uses an unsupported format.',
	recovery: 'Update the Crate plugin and server, then sync again. If it still fails, back up the note, remove only its crate-desc comment in Source mode, then re-add the description in Crate and sync again.',
};
const INVALID_DESCRIPTION: IssueExplanation = {
	summary: 'A reminder description could not be read.',
	recovery: 'Back up the note, then open it in Source mode. Remove only the broken crate-desc comment, keeping the task and its crate-id. Re-add the description in Crate, then sync again.',
};
const DUPLICATE_REMINDER_ID: IssueExplanation = {
	summary: 'Multiple reminders have the same identifier.',
	recovery: 'Review duplicate tasks in the affected notes. Select Refresh reminders in Crate to assign unique identifiers, then sync again.',
};
const MARKDOWN_ENCODING: IssueExplanation = {
	summary: 'This note uses a text encoding that reminders cannot read.',
	recovery: 'Keep a copy of the original note, then save it as UTF-8 without null characters. Refresh reminders and sync again.',
};
const REMINDER_NOTE_TOO_LARGE: IssueExplanation = {
	summary: 'This note is too large to index its reminders.',
	recovery: 'Split the note into files of 1 MiB or smaller, then sync again. Its file contents remain synced while reminders need attention.',
};
const FILE_TOO_LARGE: IssueExplanation = {
	summary: 'This file exceeds the sync size limit.',
	recovery: 'Reduce the file to 25 MiB or smaller, or exclude it from sync in Crate settings. Then sync again.',
};
const VAULT_SCAN_INCOMPLETE: IssueExplanation = {
	summary: 'Crate could not finish reading the vault.',
	recovery: 'Check that the listed file or folder is available on this device and Obsidian has permission to read it. Then select Sync vault.',
};
const INCOMPATIBLE_PATH: IssueExplanation = {
	summary: 'This file’s name or location is not compatible with sync on this device.',
	recovery: 'Review the filename details below. Rename the affected file on the source device to resolve the invalid name or collision, then sync again.',
};
const TRANSFER_UNVERIFIED: IssueExplanation = {
	summary: 'Crate could not verify the file transfer.',
	recovery: 'Select Sync vault to retry. If this repeats, update the plugin and server, then run sync diagnostics in Crate settings.',
};
const INCOMING_REVIEW: IssueExplanation = {
	summary: 'An incoming version of this file is waiting for review.',
	recovery: 'Open the Conflicts tab, compare both versions and choose which to keep. Other files keep syncing.',
};

const EXPLANATIONS_BY_CODE: Record<SyncIssueCode, IssueExplanation> = {
	'more-reminder-issues': MORE_REMINDER_ISSUES,
	'unsupported-description-encoding': UNSUPPORTED_DESCRIPTION,
	'invalid-description-block': INVALID_DESCRIPTION,
	'invalid-description-encoding': INVALID_DESCRIPTION,
	'duplicate-reminder-id': DUPLICATE_REMINDER_ID,
	'invalid-markdown-encoding': MARKDOWN_ENCODING,
	'reminder-note-too-large': REMINDER_NOTE_TOO_LARGE,
	'file-too-large': FILE_TOO_LARGE,
	'vault-scan-incomplete': VAULT_SCAN_INCOMPLETE,
	'transfer-unverified': TRANSFER_UNVERIFIED,
	'unsupported-device-path': INCOMPATIBLE_PATH,
	'incoming-review': INCOMING_REVIEW,
};

/** Message matching for OS, HTTP and transport errors, and for issues saved or
 * sent without a code by older plugins and servers. Order matters. */
const MESSAGE_RULES: Array<[RegExp, IssueExplanation]> = [
	[/More reminder notes need attention/i, MORE_REMINDER_ISSUES],
	[/Unsupported reminder description encoding/i, UNSUPPORTED_DESCRIPTION],
	[/Invalid reminder description (?:block|encoding)|URI malformed|URIError/i, INVALID_DESCRIPTION],
	[/Duplicate reminder identit|Duplicate reminder identifier/i, DUPLICATE_REMINDER_ID],
	[/UTF-8|null characters|NUL-containing/i, MARKDOWN_ENCODING],
	[/1 MiB|reminder note into smaller files|oversized.*reminder/i, REMINDER_NOTE_TOO_LARGE],
	[/25\s*(?:MB|MiB)|file is too large|file size.*limit/i, FILE_TOO_LARGE],
	[/unresolved.*schedule|persisted.*schedule|unsupported.*(?:repeat|recurrence)|invalid.*(?:recurrence|reminder date)/i, {
		summary: 'A reminder date or repeat rule could not be read.',
		recovery: 'Open the note and correct the task’s date or repeat rule. Refresh reminders, then sync again.' }],
	[/\b401\b|unauthorized|sync access is no longer valid/i, {
		summary: 'This device needs to reconnect to sync.',
		recovery: 'In Crate settings → Account and devices, select Reconnect. Then sync again.' }],
	[/\b403\b|forbidden/i, {
		summary: 'The server denied this device access.',
		recovery: 'Check this device’s connection in Crate settings → Account and devices. Reconnect with a vault device credential, then sync again.' }],
	[/\b429\b|too many requests|rate.limit/i, {
		summary: 'The server is temporarily limiting requests.',
		recovery: 'Wait a minute, then select Sync vault. Your pending changes will be retried.' }],
	[/\bENOSPC\b|disk.*full|no space left/i, {
		summary: 'This device has run out of storage space.',
		recovery: 'Free space on the device, then select Sync vault to resume.' }],
	[/free daily database limit/i, {
		summary: 'Cloudflare’s free daily database limit stopped this sync.',
		recovery: 'Your changes stay on this device. Sync again after the limit resets at 00:00 UTC. Cloudflare usage in Crate settings shows today’s totals; a Workers Paid plan removes the daily limit.' }],
	[/quota|storage limit|D1.*limit|too many (?:SQL|subrequests)/i, {
		summary: 'A storage or server limit stopped this sync.',
		recovery: 'Check available device storage and the server’s usage limits in Crate settings. After freeing space or resolving the limit, sync again.' }],
	[/Invalid sync path|Cannot access .* on this Windows device|portable path|parent folder|case.fold|filename collision/i, INCOMPATIBLE_PATH],
	[/Vault scan incomplete/i, VAULT_SCAN_INCOMPLETE],
	[/\bEACCES\b|\bEPERM\b|permission denied|read.only/i, {
		summary: 'Crate could not access this file.',
		recovery: 'Check the vault folder’s permissions and that the file is available on this device. Then sync again.' }],
	[/journal|checkpoint|recovery base|receipt.*unresolved|unresolved.*upload|upload.*unresolved/i, {
		summary: 'Crate could not finish recovering a previous sync.',
		recovery: 'Keep the vault and Crate’s saved sync data intact. Make sure storage and the server are available, then sync again. If it repeats, run sync diagnostics in Crate settings and copy these details.' }],
	[/hash mismatch|size mismatch|invalid.*(?:upload|download|receipt|sync response)|response.*(?:paths|match)|missing.*(?:response|hash|version)|hash missing/i, TRANSFER_UNVERIFIED],
	[/file.*changed|changed.*(?:file|upload|download)|disappeared|\bENOENT\b|did not converge|version.conflict/i, {
		summary: 'A file changed or moved while sync was running.',
		recovery: 'Finish editing or moving the file, then select Sync vault. Review the Conflicts tab if Crate reports competing edits.' }],
	[/delet(?:ion|ing).*deferred|stopped before deleting/i, {
		summary: 'A deletion is waiting for other changes to finish syncing.',
		recovery: 'Resolve the other listed errors, then sync again. Crate has kept the server copy until those changes are safe.' }],
	[/incompatible|unsupported.*protocol|\b428\b/i, {
		summary: 'The plugin and server need compatible versions.',
		recovery: 'Update both the Crate plugin and server, then sync again.' }],
	[/connection changed|fetch failed|failed to fetch|network|offline|\b5\d\d\b|internal server error/i, {
		summary: 'The sync server could not complete this request.',
		recovery: 'Check your connection and that the server is running, then select Sync vault. If it repeats, run sync diagnostics in Crate settings.' }],
	[/^Not configured$/i, {
		summary: 'Sync is not connected to a server.',
		recovery: 'Connect a server in Crate settings, then select Sync vault.' }],
];

const atLine = ({ summary, recovery }: IssueExplanation, line: string | number | undefined): IssueExplanation =>
	({ summary: line ? `${summary} See line ${line}.` : summary, recovery });

/** Explain known failure modes without guessing a file from an exception string. */
export function explainSyncIssue(issue: SyncIssue, serverUrl = ''): IssueExplanation {
	if (issue.code) return atLine(EXPLANATIONS_BY_CODE[issue.code], issue.line);
	const message = issue.message;
	const connection = syncConnectionFailureMessage(message, serverUrl);
	if (connection) return { summary: 'Crate could not reach the sync server.', recovery: connection };
	const line = /on line (\d+)/i.exec(message)?.[1];
	for (const [pattern, explanation] of MESSAGE_RULES) {
		if (pattern.test(message)) return atLine(explanation, line);
	}
	return {
		summary: issue.scope === 'reminders' ? 'Reminder setup needs attention.' : issue.path ? 'This file could not finish syncing.' : 'Sync could not finish.',
		recovery: 'Review the details below, then select Sync vault to retry. If this repeats, run sync diagnostics in Crate settings and copy the error details.',
	};
}
