import { patchReadingFrontmatter } from './frontmatter';
import type { ReadingMetadata } from './model';
import { isEmptyReadingCapture, readingDeleteIssue, readingUpdateIssue } from './mutation-policy';
import { updateReadingNote } from './notes';

/** An edit to an existing note, with the client's view of it. */
export interface ReadingFileCommand {
	action: 'delete' | 'retry' | 'update';
	before?: unknown;
	changes?: unknown;
	markdownHash?: unknown;
}

/** `invalid` is a malformed request, `unsupported` names a field no writer changes,
 * `conflict` means the note changed since the client read it, and `not-empty` is a
 * retry of a capture whose article is already saved. */
export type ReadingFileCommandIssue = 'invalid' | 'unsupported' | 'conflict' | 'not-empty';

export type ReadingFileCommandPlan =
	| { kind: 'remove' }
	| { kind: 'write'; content: string }
	| { kind: 'issue'; issue: ReadingFileCommandIssue; message?: string };

/** Plan one edit to an existing note. The Worker and the encrypted web app writer share
 * these rules; fetch consent, identity checks, wording and the commit stay with the caller. */
export async function planReadingFileCommand(item: ReadingMetadata, content: string, command: ReadingFileCommand): Promise<ReadingFileCommandPlan> {
	if (command.action === 'delete') {
		// The note must still be what the client showed, so a stale delete never removes newer edits.
		const issue = await readingDeleteIssue(item, content, command.before, command.markdownHash);
		return issue ? { kind: 'issue', issue } : { kind: 'remove' };
	}
	if (command.action === 'retry') {
		return isEmptyReadingCapture(content, item)
			? { kind: 'write', content: patchReadingFrontmatter(content, { extraction_status: 'pending' }) }
			: { kind: 'issue', issue: 'not-empty' };
	}
	const { before, changes } = command;
	if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !before || typeof before !== 'object') return { kind: 'issue', issue: 'invalid' };
	const issue = readingUpdateIssue(item, before, changes);
	if (issue) return { kind: 'issue', issue };
	try { return { kind: 'write', content: updateReadingNote(content, item.crate_reading_id, changes) }; }
	catch (error) { return { kind: 'issue', issue: 'invalid', ...error instanceof Error ? { message: error.message } : {} }; }
}
