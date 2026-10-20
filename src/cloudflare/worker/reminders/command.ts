import { applyReminderFileCommand, ReminderCommandError, type ReminderFileCommandOptions } from '@/reminders/core/reminderFileCommand';
import { ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { ReminderReorderConflictError } from '@/reminders/core/markdownReminderFile';
import { isSha256Hex } from '@/platform/validation';
import { corsResponse } from '../cors';
import { parseStringArray } from '../request-validation';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';
import { writeCommittedMarkdownFilePair } from '../sync/atomic-markdown-write';
import type { Env } from '../types';
import { assertUniqueReminderSources } from './source-identity';
import { ReminderFileSizeError } from './limits';
import { reminderOperationEffects, type ReminderOperation } from './operations';
import { saveReminderFileCache } from './cache/index';
import { scanReminderMarkdownFile } from './scan';

type ReminderAction = 'create' | 'update' | 'set-completed' | 'delete' | 'reorder';

// Paging changes only mounted rows; reorder still submits the complete project
// order. The shared JSON reader also bounds the entire request to 1 MiB.
export const MAX_REORDER_REMINDERS = 10_000;
const REMINDER_EXISTS = 'This reminder already exists. Reload to see its committed state.';
export const PLAINTEXT_COMMAND_OPTIONS: ReminderFileCommandOptions = { limitWrittenNotesOnly: true, allowUnverifiedResult: true };

/** Plaintext routes keep the failure responses released before they shared the
 * Markdown command. `request` is the body as received. */
export function plaintextFailureResponse(error: unknown, request: Record<string, unknown>): Response {
	if (error instanceof ReminderInputError && error.field === 'recurrence') return corsResponse({ error: error.message }, 400);
	if (error instanceof ReminderReorderConflictError) return corsResponse({ error: error.message, code: 'reminder_order_conflict' }, 409);
	if (!(error instanceof ReminderCommandError)) throw error;
	switch (error.reason) {
		case 'exists': return corsResponse({ error: REMINDER_EXISTS }, 409);
		case 'missing': return corsResponse({ error: 'Reminder not found' }, 404);
		// The Markdown edit itself refused duplicate identities in one note.
		case 'duplicate': return corsResponse({ error: 'Duplicate reminder identifiers. Refresh the note before editing; nothing was changed.', code: 'reminder_markdown_context' }, 409);
		case 'stale': return isSha256Hex(request.expectedRevision)
			? corsResponse({ error: 'Reminder changed on another device. Reload it and review your draft before saving', code: 'version_conflict' }, 409)
			: corsResponse({ error: 'Reload the reminder before saving', code: 'revision_required' }, 428);
		case 'order': return !Array.isArray(request.expectedOrder)
			? corsResponse({ error: 'Expected project order required. Reload before reordering.' }, 428)
			: !parseStringArray(request.expectedOrder, MAX_REORDER_REMINDERS, 128)
				? corsResponse({ error: 'Invalid expected project order.' }, 400)
				: corsResponse({ error: 'Project order changed. Reload before reordering.' }, 409);
	}
	if (error.code === 'file_too_large') throw new ReminderFileSizeError(error.message);
	if (error.code === 'not_found') return corsResponse({ error: 'Project file not found' }, 404);
	throw error;
}

/** Applies a validated plaintext edit with the shared Markdown command, then
 * publishes it with its operation receipt and refreshes the parsed caches.
 * `body` is the route's normalized command input; `request` is the body as received. */
export async function commitReminderCommand(env: Env, operation: ReminderOperation, action: ReminderAction,
	body: Record<string, unknown>, folderPath: string, request = body): Promise<Response> {
	if (action === 'create' && await env.DB.prepare('SELECT reminder_id FROM reminder_identities WHERE reminder_id = ?').bind(operation.id).first()) {
		return corsResponse({ error: REMINDER_EXISTS }, 409);
	}
	const versions = new Map<string, { content: string; hash: string } | null>();
	let command;
	try {
		command = await applyReminderFileCommand(action, body, folderPath, async path => {
			const file = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path);
			versions.set(path, file);
			return file?.content ?? null;
		}, PLAINTEXT_COMMAND_OPTIONS);
	} catch (error) {
		return plaintextFailureResponse(error, request);
	}
	const files = command.files.map(file => ({ ...file, reminders: file.reminders ?? scanReminderMarkdownFile(file.path, file.content, folderPath) }));
	// Edit routes check their identity before reading; a reorder learns its
	// identities from the note.
	if (action === 'reorder') await assertUniqueReminderSources(env.DB, folderPath, files[0]!.reminders.map(reminder => reminder.id));
	const effects = reminderOperationEffects(env.DB, operation, command.response, command.createdId);
	const expectedHash = (path: string) => versions.get(path)?.hash ?? null;
	const [source, destination] = files;
	const hashes = destination
		? await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, {
			effects,
			source: { path: source!.path, content: source!.content, expectedHash: expectedHash(source!.path)! },
			destination: { path: destination.path, content: destination.content, expectedHash: expectedHash(destination.path) },
		}).then(writes => [writes.source.hash, writes.destination.hash])
		: [(await writeCommittedMarkdownFile(env.BUCKET, env.DB, source!.path, source!.content, expectedHash(source!.path), effects)).hash];
	await Promise.all(files.map((file, index) => saveReminderFileCache(env.DB, folderPath, file.path, hashes[index]!, file.reminders)));
	return corsResponse(command.response);
}
