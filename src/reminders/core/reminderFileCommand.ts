import { scanReminderMarkdownContent, type ScannedReminderRecord } from './markdownScan';
import { reminderRevision } from './reminderRevision';
import { assertReminderMutationInput, parseReminderRecurrenceInput, parseReminderUpdateParams } from './reminderMutationInput';
import { getReminderProjectFilePath, normalizeReminderProjectPath } from './reminderProjectPath';
import { buildCreateReminderArgs, buildReminderUpdate } from './reminderMutationPlan';
import { appendCreatedReminderBlock, buildCreatedReminderBlock, buildMovedReminderBlock, buildUpdatedReminderBlock, replaceUpdatedReminderBlock, setReminderCompletionInContent } from './markdownReminderMutation';
import { deleteReminderBlockFromContent, getInitialProjectFileContent, reorderReminderBlocksInContent } from './markdownReminderFile';
import { DEFAULT_PROJECT } from './constants';

/** Distinguishes conflicts that share a status and code, for hosts that answer them differently. */
export type ReminderCommandFailure = 'exists' | 'missing' | 'duplicate' | 'stale' | 'order';
export class ReminderCommandError extends Error {
	constructor(message: string, readonly status = 409, readonly code = 'version_conflict', readonly reason?: ReminderCommandFailure) { super(message); }
}

/** Released plaintext Worker routes keep two acceptance rules of their own. */
export interface ReminderFileCommandOptions {
	/** Size-check only notes that receive a written reminder block, so deletes and
	 * reorders still apply to larger notes. */
	limitWrittenNotesOnly?: boolean;
	/** Save an edit whose line no longer reads as that reminder, answering without it. */
	allowUnverifiedResult?: boolean;
}
/** The wire record answered by the Worker routes and encrypted web apps. Fields
 * are listed explicitly so new scanner fields stay private until chosen. */
export async function reminderCommandPayload(reminder: ScannedReminderRecord) {
	return {
		revision: await reminderRevision(reminder),
		id: reminder.id,
		content: reminder.content,
		description: reminder.description,
		dueDate: reminder.dueDate,
		dueDatetime: reminder.dueDatetime,
		priority: reminder.priority,
		completed: reminder.completed,
		project: reminder.project,
		recurrence: reminder.recurrence,
		filePath: reminder.filePath,
		lineNumber: reminder.lineNumber,
	};
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;
function project(value: unknown): string {
	if (value === undefined || value === null || value === '') return DEFAULT_PROJECT;
	const normalized = normalizeReminderProjectPath(value);
	if (!normalized) throw new ReminderCommandError('Invalid reminder project', 400, 'invalid_reminder_input');
	return normalized;
}
function checkSize(content: string): void {
	if (new TextEncoder().encode(content).length > 1024 * 1024) throw new ReminderCommandError('Split reminder notes larger than 1 MiB before editing them in the web app.', 413, 'file_too_large');
}

/** Shared Markdown rules run on the enrolled client; the server receives only
 * complete encrypted replacements with immutable file preconditions. */
export async function applyReminderFileCommand(action: string, body: Record<string, unknown>, folderPath: string,
	read: (path: string) => Promise<string | null>, options: ReminderFileCommandOptions = {}) {
	const originals = new Map<string, string | null>();
	const changes = new Map<string, string>();
	const scanned = new Map<string, ScannedReminderRecord[]>();
	const load = async (path: string) => {
		if (!path.startsWith(`${folderPath}/`) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
			|| !path.toLowerCase().endsWith('.md')) throw new ReminderCommandError('File is outside this enrollment', 403, 'scope_mismatch');
		if (!originals.has(path)) originals.set(path, await read(path));
		const content = originals.get(path)!;
		if (content !== null && !options.limitWrittenNotesOnly) checkSize(content);
		return content;
	};
	const scan = (path: string, content: string) => scanReminderMarkdownContent(path, content, folderPath).reminders;
	// A note that receives a new or rewritten reminder block.
	const write = (path: string, content: string) => {
		if (options.limitWrittenNotesOnly) checkSize(content);
		changes.set(path, content);
	};
	const scanChange = (path: string) => {
		const reminders = scan(path, changes.get(path)!);
		scanned.set(path, reminders);
		return reminders;
	};
	let reminder: ScannedReminderRecord | undefined;
	let createdId: string | undefined;
	if (action === 'create') {
		assertReminderMutationInput(body, 'create');
		if (typeof body.id !== 'string' || body.id !== body.operationId) throw new ReminderCommandError('A new reminder must use its operation identity', 400, 'invalid_reminder_input');
		const name = project(body.project), path = getReminderProjectFilePath(folderPath, name);
		const content = await load(path) ?? getInitialProjectFileContent(name);
		if (scan(path, content).some(item => item.id === body.id)) throw new ReminderCommandError('This reminder already exists. Refresh its saved state.', 409, 'version_conflict', 'exists');
		const args = buildCreateReminderArgs({ content: text(body.content)!, description: text(body.description), project: name,
			priority: body.priority === 1 ? 1 : 4, recurrence: parseReminderRecurrenceInput(body.recurrence) ?? undefined,
			dueDate: text(body.dueDate), dueDatetime: text(body.dueDatetime), id: body.id });
		const next = appendCreatedReminderBlock(content, buildCreatedReminderBlock({ ...args, content: text(body.content)!, description: text(body.description), reminderId: body.id }));
		write(path, next);
		reminder = scanChange(path).find(item => item.id === body.id);
		createdId = body.id;
	} else if (action === 'reorder') {
		const path = getReminderProjectFilePath(folderPath, project(body.project));
		const content = await load(path);
		if (content === null) throw new ReminderCommandError('Project file not found', 404, 'not_found');
		const current = scan(path, content).map(item => item.id);
		if (JSON.stringify(current) !== JSON.stringify(body.expectedOrder)) throw new ReminderCommandError('Project order changed. Refresh before reordering.', 409, 'version_conflict', 'order');
		if (!Array.isArray(body.orderedIds) || body.orderedIds.length > 10000 || body.orderedIds.some(id => typeof id !== 'string')) throw new ReminderCommandError('Invalid reminder order', 400, 'invalid_reminder_input');
		changes.set(path, reorderReminderBlocksInContent(content, body.orderedIds as string[]));
	} else {
		if (typeof body.filePath !== 'string' || typeof body.id !== 'string') throw new ReminderCommandError('Reload the reminder before saving', 428, 'revision_required');
		const path = body.filePath, content = await load(path);
		const matches = content === null ? [] : scan(path, content).filter(item => item.id === body.id);
		if (matches.length !== 1) throw new ReminderCommandError('Reminder moved, was deleted, or has duplicate identities. Refresh before saving.', 409, 'version_conflict', matches.length ? 'duplicate' : 'missing');
		const current = matches[0]!;
		if (typeof body.expectedRevision !== 'string' || body.expectedRevision !== await reminderRevision(current)) throw new ReminderCommandError('Reminder changed on another device. Reload it and review your draft before saving.', 409, 'version_conflict', 'stale');
		if (action === 'delete') changes.set(path, deleteReminderBlockFromContent(content, current).content);
		else if (action === 'set-completed') {
			if (typeof body.completed !== 'boolean') throw new ReminderCommandError('Choose a completion state', 400, 'invalid_reminder_input');
			if (current.completed === body.completed) changes.set(path, content);
			else write(path, setReminderCompletionInContent(content, current, body.completed).content);
		} else if (action === 'update') {
			const update = buildReminderUpdate(parseReminderUpdateParams(body)).updates;
			if (update.project && update.project !== current.project) {
				const destination = getReminderProjectFilePath(folderPath, update.project);
				const before = await load(destination) ?? getInitialProjectFileContent(update.project);
				if (scan(destination, before).some(item => item.id === current.id)) throw new ReminderCommandError('The destination already contains this reminder', 409, 'version_conflict', 'duplicate');
				const next = appendCreatedReminderBlock(before, buildMovedReminderBlock(current, update));
				changes.set(path, deleteReminderBlockFromContent(content, current).content);
				write(destination, next);
				reminder = scanChange(destination).find(item => item.id === current.id);
			} else write(path, replaceUpdatedReminderBlock(content, current, buildUpdatedReminderBlock(current, update)).content);
		} else throw new ReminderCommandError('Unsupported reminder operation', 400, 'invalid_reminder_input');
		if (action !== 'delete' && !reminder) reminder = scanChange(path).find(item => item.id === current.id);
	}
	if (!options.limitWrittenNotesOnly) for (const content of changes.values()) checkSize(content);
	if (!['delete', 'reorder'].includes(action) && !reminder && !options.allowUnverifiedResult) throw new Error('The edited reminder could not be verified');
	// `reminders` is present when the command already scanned the changed note.
	return { files: [...changes].map(([path, content]) => ({ path, content, original: originals.get(path)!, reminders: scanned.get(path) })), createdId,
		response: { success: true, ...(reminder ? { reminder: await reminderCommandPayload(reminder) } : action === 'delete' ? { id: body.id } : {}) } };
}
