import { scanReminderMarkdownContent } from './markdownScan';
import { reminderRevision } from './reminderRevision';
import { assertReminderMutationInput } from './reminderMutationInput';
import { getReminderProjectFilePath, normalizeReminderProjectPath } from './reminderProjectPath';
import { validateRecurrence } from './validateRecurrence';
import { buildCreateReminderArgs, buildReminderUpdate } from '../data/reminder-repository/shared';
import { appendCreatedReminderBlock, buildCreatedReminderBlock, buildUpdatedReminderBlock, replaceUpdatedReminderBlock, setReminderCompletionInContent } from './markdownReminderMutation';
import { deleteReminderBlockFromContent, getInitialProjectFileContent, reorderReminderBlocksInContent } from './markdownReminderFile';
import { parseStoredReminderDate, reminderHasTime } from '../utils/reminderDate';
import { normalizeRecurrenceRule } from '../utils/recurrenceRule';
import type { UpdateReminderParams, RecurrenceRule } from '../types/reminder';

export class ReminderCommandError extends Error {
	constructor(message: string, readonly status = 409, readonly code = 'version_conflict') { super(message); }
}
type ScannedReminder = ReturnType<typeof scanReminderMarkdownContent>['reminders'][number];
export async function reminderCommandPayload(reminder: ScannedReminder) {
	const { rawLine: _rawLine, contentHash: _contentHash, ...value } = reminder;
	return { ...value, revision: await reminderRevision(reminder) };
}

function recurrence(value: unknown): RecurrenceRule | null | undefined {
	if (value === undefined || value === null) return value;
	const parsed = validateRecurrence(value);
	if (!('rule' in parsed)) throw new ReminderCommandError(parsed.error, 400, 'invalid_reminder_input');
	return parsed.rule;
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;
function project(value: unknown): string {
	if (value === undefined || value === null || value === '') return 'Inbox';
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
	read: (path: string) => Promise<string | null>) {
	const originals = new Map<string, string | null>();
	const changes = new Map<string, string>();
	const load = async (path: string) => {
		if (!path.startsWith(`${folderPath}/`) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
			|| !path.toLowerCase().endsWith('.md')) throw new ReminderCommandError('File is outside this enrollment', 403, 'scope_mismatch');
		if (!originals.has(path)) originals.set(path, await read(path));
		const content = originals.get(path)!;
		if (content !== null) checkSize(content);
		return content;
	};
	const scan = (path: string, content: string) => scanReminderMarkdownContent(path, content, folderPath).reminders;
	let reminder: ScannedReminder | undefined;
	let createdId: string | undefined;
	if (action === 'create') {
		assertReminderMutationInput(body, 'create');
		if (typeof body.id !== 'string' || body.id !== body.operationId) throw new ReminderCommandError('A new reminder must use its operation identity', 400, 'invalid_reminder_input');
		const name = project(body.project), path = getReminderProjectFilePath(folderPath, name);
		const content = await load(path) ?? getInitialProjectFileContent(name);
		if (scan(path, content).some(item => item.id === body.id)) throw new ReminderCommandError('This reminder already exists. Refresh its saved state.');
		const args = buildCreateReminderArgs({ content: text(body.content)!, description: text(body.description), project: name,
			priority: body.priority === 1 ? 1 : 4, recurrence: recurrence(body.recurrence) ?? undefined,
			dueDate: text(body.dueDate), dueDatetime: text(body.dueDatetime), id: body.id });
		const next = appendCreatedReminderBlock(content, buildCreatedReminderBlock({ ...args, content: text(body.content)!, description: text(body.description), reminderId: body.id }));
		changes.set(path, next);
		reminder = scan(path, next).find(item => item.id === body.id);
		createdId = body.id;
	} else if (action === 'reorder') {
		const path = getReminderProjectFilePath(folderPath, project(body.project));
		const content = await load(path);
		if (content === null) throw new ReminderCommandError('Project file not found', 404, 'not_found');
		const current = scan(path, content).map(item => item.id);
		if (JSON.stringify(current) !== JSON.stringify(body.expectedOrder)) throw new ReminderCommandError('Project order changed. Refresh before reordering.');
		if (!Array.isArray(body.orderedIds) || body.orderedIds.length > 10000 || body.orderedIds.some(id => typeof id !== 'string')) throw new ReminderCommandError('Invalid reminder order', 400, 'invalid_reminder_input');
		changes.set(path, reorderReminderBlocksInContent(content, body.orderedIds as string[]));
	} else {
		if (typeof body.filePath !== 'string' || typeof body.id !== 'string') throw new ReminderCommandError('Reload the reminder before saving', 428, 'revision_required');
		const path = body.filePath, content = await load(path);
		const matches = content === null ? [] : scan(path, content).filter(item => item.id === body.id);
		if (matches.length !== 1) throw new ReminderCommandError('Reminder moved, was deleted, or has duplicate identities. Refresh before saving.');
		const current = matches[0]!;
		if (typeof body.expectedRevision !== 'string' || body.expectedRevision !== await reminderRevision(current)) throw new ReminderCommandError('Reminder changed on another device. Reload it and review your draft before saving.');
		if (action === 'delete') changes.set(path, deleteReminderBlockFromContent(content, current).content);
		else if (action === 'set-completed') {
			if (typeof body.completed !== 'boolean') throw new ReminderCommandError('Choose a completion state', 400, 'invalid_reminder_input');
			changes.set(path, current.completed === body.completed ? content : setReminderCompletionInContent(content, current, body.completed).content);
		} else if (action === 'update') {
			assertReminderMutationInput(body, 'update');
			const params: UpdateReminderParams = {};
			for (const field of ['content', 'dueDate', 'dueDatetime'] as const) if (field in body) params[field] = text(body[field]);
			if ('description' in body) params.description = body.description === null ? '' : text(body.description);
			if ('priority' in body) params.priority = body.priority === 1 ? 1 : 4;
			if ('project' in body && text(body.project)) params.project = project(body.project);
			if ('recurrence' in body) params.recurrence = recurrence(body.recurrence) ?? null;
			const update = buildReminderUpdate(params).updates;
			if (update.project && update.project !== current.project) {
				const destination = getReminderProjectFilePath(folderPath, update.project);
				const before = await load(destination) ?? getInitialProjectFileContent(update.project);
				if (scan(destination, before).some(item => item.id === current.id)) throw new ReminderCommandError('The destination already contains this reminder');
				const next = appendCreatedReminderBlock(before, buildCreatedReminderBlock({ reminderId: current.id,
					content: update.content ?? current.content, description: 'description' in update ? update.description?.trim() || undefined : current.description,
					dueDate: 'dueDate' in update ? update.dueDate : parseStoredReminderDate(current), priority: update.priority ?? current.priority,
					recurrence: 'recurrence' in update ? normalizeRecurrenceRule(update.recurrence ?? undefined) : current.recurrence,
					hasTime: 'hasTime' in update ? update.hasTime : reminderHasTime(current), completed: current.completed }));
				changes.set(path, deleteReminderBlockFromContent(content, current).content);
				changes.set(destination, next);
				reminder = scan(destination, next).find(item => item.id === current.id);
			} else changes.set(path, replaceUpdatedReminderBlock(content, current, buildUpdatedReminderBlock(current, update)).content);
		} else throw new ReminderCommandError('Unsupported reminder operation', 400, 'invalid_reminder_input');
		if (action !== 'delete' && !reminder) reminder = scan(path, changes.get(path)!).find(item => item.id === current.id);
	}
	for (const content of changes.values()) checkSize(content);
	if (!['delete', 'reorder'].includes(action) && !reminder) throw new Error('The edited reminder could not be verified');
	return { files: [...changes].map(([path, content]) => ({ path, content, original: originals.get(path)! })), createdId,
		response: { success: true, ...(reminder ? { reminder: await reminderCommandPayload(reminder) } : action === 'delete' ? { id: body.id } : {}) } };
}
