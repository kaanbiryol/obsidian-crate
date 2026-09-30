import type { SyncIssue } from '../../sync/types';
import { syncConnectionFailureMessage } from '../settings/self-hosted-errors';

interface IssueExplanation { summary: string; recovery: string }

/** Explain known failure modes without guessing a file from an exception string. */
export function explainSyncIssue(issue: SyncIssue, serverUrl = ''): IssueExplanation {
	const message = issue.message;
	const connection = syncConnectionFailureMessage(message, serverUrl);
	if (connection) return { summary: 'Crate could not reach the sync server.', recovery: connection };
	const rules: Array<[RegExp, string, string]> = [
		[/More reminder notes need attention/i,
			'More reminder notes need attention.',
			'Repair the listed notes, then sync again to review the remaining files.'],
		[/Unsupported reminder description encoding/i,
			'A reminder description uses an unsupported format.',
			'Update the Crate plugin and server, then sync again. If it still fails, back up the note, remove only its crate-desc comment in Source mode, then re-add the description in Crate and sync again.'],
		[/Invalid reminder description (?:block|encoding)|URI malformed|URIError/i,
			'A reminder description could not be read.',
			'Back up the note, then open it in Source mode. Remove only the broken crate-desc comment, keeping the task and its crate-id. Re-add the description in Crate, then sync again.'],
		[/Duplicate reminder identit|Duplicate reminder identifier/i,
			'Multiple reminders have the same identifier.',
			'Review duplicate tasks in the affected notes. Select Refresh reminders in Crate to assign unique identifiers, then sync again.'],
		[/UTF-8|null characters|NUL-containing/i,
			'This note uses a text encoding that reminders cannot read.',
			'Keep a copy of the original note, then save it as UTF-8 without null characters. Refresh reminders and sync again.'],
		[/1 MiB|reminder note into smaller files|oversized.*reminder/i,
			'This note is too large to index its reminders.',
			'Split the note into files of 1 MiB or smaller, then sync again. Its file contents remain synced while reminders need attention.'],
		[/25\s*(?:MB|MiB)|file is too large|file size.*limit/i,
			'This file exceeds the sync size limit.',
			'Reduce the file to 25 MiB or smaller, or exclude it from sync in Crate settings. Then sync again.'],
		[/unresolved.*schedule|persisted.*schedule|unsupported.*(?:repeat|recurrence)|invalid.*(?:recurrence|reminder date)/i,
			'A reminder date or repeat rule could not be read.',
			'Open the note and correct the task’s date or repeat rule. Refresh reminders, then sync again.'],
		[/\b401\b|unauthorized|sync access is no longer valid/i,
			'This device needs to reconnect to sync.',
			'In Crate settings → Account and devices, select Reconnect. Then sync again.'],
		[/\b403\b|forbidden/i,
			'The server denied this device access.',
			'Check this device’s connection in Crate settings → Account and devices. Reconnect with a vault device credential, then sync again.'],
		[/\b429\b|too many requests|rate.limit/i,
			'The server is temporarily limiting requests.',
			'Wait a minute, then select Sync vault. Your pending changes will be retried.'],
		[/\bENOSPC\b|disk.*full|no space left/i,
			'This device has run out of storage space.',
			'Free space on the device, then select Sync vault to resume.'],
		[/quota|storage limit|D1.*limit|too many (?:SQL|subrequests)/i,
			'A storage or server limit stopped this sync.',
			'Check available device storage and the server’s usage limits in Crate settings. After freeing space or resolving the limit, sync again.'],
		[/Invalid sync path|Cannot access .* on this Windows device|portable path|parent folder|case.fold|filename collision/i,
			'This file’s name or location is not compatible with sync on this device.',
			'Review the filename details below. Rename the affected file on the source device to resolve the invalid name or collision, then sync again.'],
		[/Vault scan incomplete/i,
			'Crate could not finish reading the vault.',
			'Check that the listed file or folder is available on this device and Obsidian has permission to read it. Then select Sync vault.'],
		[/\bEACCES\b|\bEPERM\b|permission denied|read.only/i,
			'Crate could not access this file.',
			'Check the vault folder’s permissions and that the file is available on this device. Then sync again.'],
		[/journal|checkpoint|recovery base|receipt.*unresolved|unresolved.*upload|upload.*unresolved/i,
			'Crate could not finish recovering a previous sync.',
			'Keep the vault and Crate’s saved sync data intact. Make sure storage and the server are available, then sync again. If it repeats, run sync diagnostics in Crate settings and copy these details.'],
		[/hash mismatch|size mismatch|invalid.*(?:upload|download|receipt|sync response)|response.*(?:paths|match)|missing.*(?:response|hash|version)|hash missing/i,
			'Crate could not verify the file transfer.',
			'Select Sync vault to retry. If this repeats, update the plugin and server, then run sync diagnostics in Crate settings.'],
		[/file.*changed|changed.*(?:file|upload|download)|disappeared|\bENOENT\b|did not converge|version.conflict/i,
			'A file changed or moved while sync was running.',
			'Finish editing or moving the file, then select Sync vault. Review the Conflicts tab if Crate reports competing edits.'],
		[/delet(?:ion|ing).*deferred|stopped before deleting/i,
			'A deletion is waiting for other changes to finish syncing.',
			'Resolve the other listed errors, then sync again. Crate has kept the server copy until those changes are safe.'],
		[/incompatible|unsupported.*protocol|\b428\b/i,
			'The plugin and server need compatible versions.',
			'Update both the Crate plugin and server, then sync again.'],
		[/connection changed|fetch failed|failed to fetch|network|offline|\b5\d\d\b|internal server error/i,
			'The sync server could not complete this request.',
			'Check your connection and that the server is running, then select Sync vault. If it repeats, run sync diagnostics in Crate settings.'],
		[/^Not configured$/i,
			'Sync is not connected to a server.',
			'Connect a server in Crate settings, then select Sync vault.'],
	];
	const line = /on line (\d+)/i.exec(message)?.[1];
	for (const [pattern, summary, recovery] of rules) {
		if (pattern.test(message)) return { summary: line ? `${summary} See line ${line}.` : summary, recovery };
	}
	return {
		summary: issue.scope === 'reminders' ? 'Reminder setup needs attention.' : issue.path ? 'This file could not finish syncing.' : 'Sync could not finish.',
		recovery: 'Review the details below, then select Sync vault to retry. If this repeats, run sync diagnostics in Crate settings and copy the error details.',
	};
}
