import { calculateFirstOccurrence, calculateNextOccurrence } from '@/reminders/utils/recurrenceCalculator';
import { rebuildCheckboxLine, parseCheckboxLine, generateContentHash } from '@/reminders/utils/checkboxParser';
import {
	buildStoredReminderDates,
	inferHasTimeFromDate,
	parseReminderDateValue,
	parseStoredReminderDate,
	reminderHasTime,
} from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { getProjectColor } from '@/reminders/utils/projectColors';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import type { UpdateReminderParams } from '@/reminders/types/plugin-reminder';
import { createReminderId, extractReminderId, setReminderIdMarker } from '@/reminders/data/reminderIdentity';
import { buildCreateReminderArgs, buildReminderUpdate } from '@/reminders/data/storageCompatShared';
import { corsResponse } from './cors';
import { listStoredMarkdownFilesByPrefix, readCommittedMarkdownFile, writeCommittedMarkdownFile } from './storage';
import { cancelScheduledReminder, scheduleScheduledReminder } from './reminder-handlers';
import type { Env } from './types';
import { parseJsonObject, parseOptionalString, parseStringArray, sanitizePath } from './utils';

interface RemoteReminderRecord {
	id: string;
	content: string;
	description?: string;
	dueDate?: string;
	dueDatetime?: string;
	priority: Priority;
	completed: boolean;
	project: string;
	recurrence?: RecurrenceRule;
	filePath: string;
	lineNumber: number;
	rawLine: string;
	contentHash: string;
}

interface ReminderFileRecord {
	path: string;
	content: string;
}

interface ReminderWorkspace {
	folderPath: string;
	files: Map<string, ReminderFileRecord>;
	reminders: RemoteReminderRecord[];
	projects: string[];
}

function getProjectFromPath(filePath: string, remindersFolderPath: string): string {
	const normalizedFile = filePath.toLowerCase();
	const normalizedFolder = remindersFolderPath.replace(/^\/|\/$/g, '').toLowerCase();

	let relativePath = filePath;
	if (normalizedFile.startsWith(normalizedFolder + '/')) {
		relativePath = filePath.slice(remindersFolderPath.length + 1);
	}

	if (relativePath.toLowerCase().endsWith('.md')) {
		relativePath = relativePath.slice(0, -3);
	}

	return relativePath || 'Inbox';
}

function countDescriptionBlockLines(lines: string[], checkboxLineNumber: number): number {
	const nextIndex = checkboxLineNumber + 1;
	if (nextIndex >= lines.length || !lines[nextIndex].startsWith('<!-- crate-desc:')) {
		return 0;
	}

	for (let index = nextIndex; index < lines.length; index++) {
		if (lines[index].includes('-->')) {
			return index - nextIndex + 1;
		}
	}

	return 0;
}

function buildDescriptionBlock(description: string | undefined): string[] {
	if (!description?.trim()) return [];
	return [`<!-- crate-desc:${description.trim()} -->`];
}

function recurrenceKey(value: RecurrenceRule | undefined): string {
	return JSON.stringify(normalizeRecurrenceRule(value) ?? null);
}

function lineMatchesReminder(line: string, reminder: RemoteReminderRecord): boolean {
	const parsed = parseCheckboxLine(line);
	if (!parsed) {
		return false;
	}

	const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
	return parsed.parsed.cleanContent === reminder.content
		&& parsed.isCompleted === reminder.completed
		&& parsed.parsed.priority === reminder.priority
		&& storedDates.dueDate === reminder.dueDate
		&& storedDates.dueDatetime === reminder.dueDatetime
		&& recurrenceKey(parsed.parsed.recurrence) === recurrenceKey(reminder.recurrence);
}

function findReminderLineNumber(lines: string[], reminder: RemoteReminderRecord): number {
	if (
		reminder.lineNumber >= 0
		&& reminder.lineNumber < lines.length
		&& lines[reminder.lineNumber] === reminder.rawLine
	) {
		return reminder.lineNumber;
	}

	for (let index = 0; index < lines.length; index++) {
		if (extractReminderId(lines[index]) === reminder.id) {
			return index;
		}
	}

	const exactMatches: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (lines[index] === reminder.rawLine) {
			exactMatches.push(index);
		}
	}
	if (exactMatches.length === 1) {
		return exactMatches[0];
	}

	const semanticMatches: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (lineMatchesReminder(lines[index], reminder)) {
			semanticMatches.push(index);
		}
	}
	if (semanticMatches.length === 1) {
		return semanticMatches[0];
	}

	return -1;
}

function getProjectFilePath(folderPath: string, project: string): string {
	return `${folderPath}/${project}.md`;
}

function getInitialProjectFileContent(project: string): string {
	const projectName = project.split('/').pop() || project;
	return `# ${projectName}\n\n`;
}

function scanReminderMarkdownFile(filePath: string, content: string, remindersFolderPath: string): RemoteReminderRecord[] {
	const reminders: RemoteReminderRecord[] = [];
	const project = getProjectFromPath(filePath, remindersFolderPath);
	const lines = content.split('\n');

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber];
		const parsed = parseCheckboxLine(line);
		if (!parsed || !parsed.parsed.cleanContent.trim() || !parsed.reminderId) {
			continue;
		}

		const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
		let description: string | undefined;
		let descBlockLineCount = 0;
		const nextIndex = lineNumber + 1;
		if (nextIndex < lines.length && lines[nextIndex].startsWith('<!-- crate-desc:')) {
			let descContent = lines[nextIndex].slice('<!-- crate-desc:'.length);
			let endIndex = nextIndex;
			while (endIndex < lines.length) {
				const source = endIndex === nextIndex ? descContent : lines[endIndex];
				const closingPos = source.indexOf('-->');
				if (closingPos !== -1) {
					if (endIndex === nextIndex) {
						descContent = descContent.slice(0, closingPos).trimEnd();
					} else {
						descContent += '\n' + lines[endIndex].slice(0, closingPos).trimEnd();
					}
					descBlockLineCount = endIndex - nextIndex + 1;
					break;
				}
				if (endIndex > nextIndex) {
					descContent += '\n' + lines[endIndex];
				}
				endIndex++;
			}
			description = descContent.trim() || undefined;
		}

		reminders.push({
			id: parsed.reminderId,
			content: parsed.parsed.cleanContent,
			description,
			dueDate: storedDates.dueDate,
			dueDatetime: storedDates.dueDatetime,
			priority: parsed.parsed.priority,
			completed: parsed.isCompleted,
			project,
			recurrence: normalizeRecurrenceRule(parsed.parsed.recurrence),
			filePath,
			lineNumber,
			rawLine: line,
			contentHash: generateContentHash(parsed.rawContent),
		});

		if (descBlockLineCount > 0) {
			lineNumber = nextIndex + descBlockLineCount - 1;
		}
	}

	return reminders;
}

async function loadReminderWorkspace(env: Env, folderPath: string): Promise<ReminderWorkspace> {
	const files = await listStoredMarkdownFilesByPrefix(env.BUCKET, env.DB!, folderPath);
	const fileMap = new Map(files.map((file) => [file.path, file] as const));
	const reminders = files.flatMap((file) => scanReminderMarkdownFile(file.path, file.content, folderPath));
	const projects = Array.from(new Set(files.map((file) => getProjectFromPath(file.path, folderPath)))).sort((a, b) =>
		a.localeCompare(b),
	);
	return {
		folderPath,
		files: fileMap,
		reminders,
		projects,
	};
}

function toReminderPayload(reminder: RemoteReminderRecord): Record<string, unknown> {
	return {
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
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		projectColor: getProjectColor(reminder.project),
	};
}

function parseFolderPath(value: unknown): string | null {
	const parsed = parseOptionalString(value, 512);
	return parsed ? sanitizePath(parsed) : null;
}

function parseOptionalAllDayNotificationTime(value: unknown): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (value === null) {
		return null;
	}

	const parsed = parseOptionalString(value, 5);
	if (!parsed) {
		return null;
	}

	return /^\d{2}:\d{2}$/.test(parsed) ? parsed : null;
}

type RecurrenceMutationResult =
	| { ok: true; value: RecurrenceRule | null | undefined }
	| { ok: false; response: Response };

function parseRecurrenceMutationValue(value: unknown): RecurrenceMutationResult {
	if (value === undefined) {
		return { ok: true, value: undefined };
	}

	if (value === null) {
		return { ok: true, value: null };
	}

	if (typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, response: corsResponse({ error: 'Invalid recurrence' }, 400) };
	}

	const raw = value as Partial<RecurrenceRule>;
	if (raw.frequency !== 'daily' && raw.frequency !== 'weekly' && raw.frequency !== 'monthly') {
		return { ok: false, response: corsResponse({ error: 'Invalid recurrence frequency' }, 400) };
	}

	const rule: RecurrenceRule = { frequency: raw.frequency };
	if (raw.interval !== undefined) {
		if (!Number.isInteger(raw.interval) || raw.interval < 1 || raw.interval > 365) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence interval' }, 400) };
		}
		rule.interval = raw.interval;
	}
	if (raw.daysOfWeek !== undefined) {
		if (
			!Array.isArray(raw.daysOfWeek)
			|| raw.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
		) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence daysOfWeek' }, 400) };
		}
		rule.daysOfWeek = Array.from(new Set(raw.daysOfWeek)).sort((a, b) => a - b);
	}
	if (raw.dayOfMonth !== undefined) {
		if (!Number.isInteger(raw.dayOfMonth) || raw.dayOfMonth < 1 || raw.dayOfMonth > 31) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence dayOfMonth' }, 400) };
		}
		rule.dayOfMonth = raw.dayOfMonth;
	}
	if (raw.hour !== undefined) {
		if (!Number.isInteger(raw.hour) || raw.hour < 0 || raw.hour > 23) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence hour' }, 400) };
		}
		rule.hour = raw.hour;
	}
	if (raw.minute !== undefined) {
		if (!Number.isInteger(raw.minute) || raw.minute < 0 || raw.minute > 59) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence minute' }, 400) };
		}
		rule.minute = raw.minute;
	}
	if (typeof raw.timezone === 'string' && raw.timezone.trim()) {
		rule.timezone = raw.timezone.trim();
	}

	return { ok: true, value: normalizeRecurrenceRule(rule) };
}

function resolveNotificationDatetime(
	reminder: Pick<RemoteReminderRecord, 'dueDate' | 'dueDatetime'>,
	allDayNotificationTime: string | null | undefined,
): string | undefined {
	if (reminder.dueDatetime) {
		return reminder.dueDatetime;
	}

	if (!reminder.dueDate || !allDayNotificationTime) {
		return undefined;
	}

	const [hours, minutes] = allDayNotificationTime.split(':').map(Number);
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
		return undefined;
	}

	const date = parseReminderDateValue(reminder.dueDate, false);
	if (!date) {
		return undefined;
	}

	date.setHours(hours, minutes, 0, 0);
	return date.toISOString();
}

async function syncReminderNotification(
	env: Env,
	reminder: RemoteReminderRecord | null,
	allDayNotificationTime: string | null | undefined,
): Promise<string | undefined> {
	if (!reminder) {
		return undefined;
	}

	try {
		const effectiveDatetime = resolveNotificationDatetime(reminder, allDayNotificationTime);
		if (!effectiveDatetime || reminder.completed || new Date(effectiveDatetime).getTime() <= Date.now()) {
			await cancelScheduledReminder(env, reminder.id);
			return undefined;
		}

		await scheduleScheduledReminder(env, {
			reminderId: reminder.id,
			content: reminder.content,
			project: reminder.project,
			dueDatetime: effectiveDatetime,
			priority: reminder.priority,
		});
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function cancelReminderNotification(env: Env, reminderId: string): Promise<string | undefined> {
	try {
		await cancelScheduledReminder(env, reminderId);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function parseReminderMutationWorkspace(
	value: Record<string, unknown>,
): { folderPath: string; allDayNotificationTime?: string | null } | Response {
	const folderPath = parseFolderPath(value.folderPath);
	if (!folderPath) {
		return corsResponse({ error: 'folderPath required' }, 400);
	}

	const allDayNotificationTime = parseOptionalAllDayNotificationTime(value.allDayNotificationTime);
	if (value.allDayNotificationTime !== undefined && allDayNotificationTime === null && value.allDayNotificationTime !== null) {
		return corsResponse({ error: 'Invalid allDayNotificationTime' }, 400);
	}

	return { folderPath, allDayNotificationTime };
}

function createReminderInFileContent(
	fileContent: string,
	params: {
		content: string;
		description?: string;
		dueDate: Date | undefined;
		priority: Priority;
		recurrence?: RecurrenceRule;
		hasTime?: boolean;
		reminderId: string;
	},
): string {
	const normalizedRecurrence = normalizeRecurrenceRule(params.recurrence);
	let effectiveDueDate = params.dueDate;
	if (normalizedRecurrence && !effectiveDueDate) {
		effectiveDueDate = calculateFirstOccurrence(normalizedRecurrence);
	}

	const resolvedHasTime = params.hasTime ?? inferHasTimeFromDate(effectiveDueDate);
	const newLine = rebuildCheckboxLine(
		'',
		false,
		params.content,
		effectiveDueDate,
		params.priority,
		undefined,
		normalizedRecurrence,
		resolvedHasTime,
		params.reminderId,
	);
	const descriptionLines = buildDescriptionBlock(params.description?.trim() || undefined);
	const trimmed = fileContent.trimEnd();
	const separator = trimmed.match(/^#[^\n]*$/) ? '\n\n' : '\n';
	const block = descriptionLines.length > 0
		? `${newLine}\n${descriptionLines.join('\n')}`
		: newLine;
	return `${trimmed}${separator}${block}\n`;
}

function deleteReminderFromFileContent(fileContent: string, reminder: RemoteReminderRecord): string {
	const lines = fileContent.split('\n');
	const lineToDelete = findReminderLineNumber(lines, reminder);
	if (lineToDelete === -1) {
		return fileContent;
	}

	const descCount = countDescriptionBlockLines(lines, lineToDelete);
	lines.splice(lineToDelete, 1 + descCount);
	return lines.join('\n');
}

function updateReminderInFileContent(
	fileContent: string,
	reminder: RemoteReminderRecord,
	update: ReturnType<typeof buildReminderUpdate>,
): string {
	const lines = fileContent.split('\n');
	const lineNumber = findReminderLineNumber(lines, reminder);
	if (lineNumber === -1) {
		throw new Error(`Cannot safely locate reminder line in ${reminder.filePath}`);
	}

	const currentDueDate = parseStoredReminderDate(reminder);
	const currentHasTime = reminderHasTime(reminder);
	const newRecurrence = Object.prototype.hasOwnProperty.call(update.updates, 'recurrence')
		? normalizeRecurrenceRule(update.updates.recurrence ?? undefined)
		: normalizeRecurrenceRule(reminder.recurrence);
	const newHasTime = Object.prototype.hasOwnProperty.call(update.updates, 'hasTime')
		? update.updates.hasTime
		: ('dueDate' in update.updates ? inferHasTimeFromDate(update.updates.dueDate) : currentHasTime);
	const newContent = update.updates.content ?? reminder.content;
	const newDueDate = 'dueDate' in update.updates ? update.updates.dueDate : currentDueDate;
	const newPriority = update.updates.priority ?? reminder.priority;
	const newDescription = 'description' in update.updates
		? (update.updates.description?.trim() || undefined)
		: reminder.description;
	const newDescLines = buildDescriptionBlock(newDescription);
	const indentMatch = reminder.rawLine.match(/^(\s*)/);
	const indentation = indentMatch ? indentMatch[1] : '';
	const newLine = rebuildCheckboxLine(
		indentation,
		reminder.completed,
		newContent,
		newDueDate,
		newPriority,
		undefined,
		newRecurrence,
		newHasTime,
		reminder.id,
	);

	const oldDescCount = countDescriptionBlockLines(lines, lineNumber);
	lines.splice(lineNumber, 1 + oldDescCount, newLine, ...newDescLines);
	return lines.join('\n');
}

function setReminderCompletedInFileContent(
	fileContent: string,
	reminder: RemoteReminderRecord,
	completed: boolean,
): string {
	if (reminder.completed === completed) {
		return fileContent;
	}

	const lines = fileContent.split('\n');
	const lineNumber = findReminderLineNumber(lines, reminder);
	if (lineNumber === -1) {
		throw new Error(`Cannot safely locate reminder line in ${reminder.filePath}`);
	}

	const line = lines[lineNumber];
	const currentDue = parseStoredReminderDate(reminder) ?? new Date();
	const currentHasTime = reminderHasTime(reminder) ?? false;
	const recurrence = normalizeRecurrenceRule(reminder.recurrence);
	let newLine: string;

	if (!completed) {
		newLine = line.replace(/\[x\]/i, '[ ]');
	} else if (recurrence) {
		const nextDue = calculateNextOccurrence(currentDue, recurrence);
		if (nextDue) {
			const indentMatch = line.match(/^(\s*)/);
			const indentation = indentMatch ? indentMatch[1] : '';
			newLine = rebuildCheckboxLine(
				indentation,
				false,
				reminder.content,
				nextDue,
				reminder.priority,
				undefined,
				recurrence,
				currentHasTime,
				reminder.id,
			);
		} else {
			newLine = line.replace(/\[ \]/, '[x]');
		}
	} else {
		newLine = line.replace(/\[ \]/, '[x]');
	}

	lines[lineNumber] = setReminderIdMarker(newLine, reminder.id);
	return lines.join('\n');
}

function reorderReminderBlocksInFileContent(fileContent: string, orderedIds: string[]): string {
	const lines = fileContent.split('\n');

	interface FileSegment {
		isBlock: boolean;
		lines: string[];
		id?: string | null;
		isCompleted?: boolean;
	}

	const segments: FileSegment[] = [];
	let index = 0;
	let nonBlockAccum: string[] = [];

	while (index < lines.length) {
		const parsed = parseCheckboxLine(lines[index]);
		if (parsed) {
			if (nonBlockAccum.length > 0) {
				segments.push({ isBlock: false, lines: [...nonBlockAccum] });
				nonBlockAccum = [];
			}

			const blockLines = [lines[index]];
			const descCount = countDescriptionBlockLines(lines, index);
			for (let descIndex = 1; descIndex <= descCount; descIndex++) {
				blockLines.push(lines[index + descIndex]);
			}

			segments.push({
				isBlock: true,
				lines: blockLines,
				id: extractReminderId(lines[index]),
				isCompleted: parsed.isCompleted,
			});
			index += 1 + descCount;
		} else {
			nonBlockAccum.push(lines[index]);
			index++;
		}
	}

	if (nonBlockAccum.length > 0) {
		segments.push({ isBlock: false, lines: nonBlockAccum });
	}

	const allBlockSegments = segments.filter((segment) => segment.isBlock);
	const activeBlocks = allBlockSegments.filter((segment) => !segment.isCompleted);
	const completedBlocks = allBlockSegments.filter((segment) => segment.isCompleted);

	const activeById = new Map(activeBlocks.map((block) => [block.id, block]));
	const reorderedActive: FileSegment[] = [];
	for (const id of orderedIds) {
		const block = activeById.get(id);
		if (block) {
			reorderedActive.push(block);
			activeById.delete(id);
		}
	}

	for (const block of activeBlocks) {
		if (block.id !== null && activeById.has(block.id)) {
			reorderedActive.push(block);
		} else if (block.id === null) {
			reorderedActive.push(block);
		}
	}

	const reorderedBlocks = [...reorderedActive, ...completedBlocks];
	let blockIndex = 0;
	const result: string[] = [];
	for (const segment of segments) {
		if (segment.isBlock) {
			if (blockIndex < reorderedBlocks.length) {
				result.push(...reorderedBlocks[blockIndex].lines);
				blockIndex++;
			}
		} else {
			result.push(...segment.lines);
		}
	}

	return result.join('\n');
}

function findReminderById(workspace: ReminderWorkspace, id: string): RemoteReminderRecord | undefined {
	return workspace.reminders.find((reminder) => reminder.id === id);
}

export async function handleListReminders(request: Request, env: Env): Promise<Response> {
	const folderPath = parseFolderPath(new URL(request.url).searchParams.get('folderPath'));
	if (!folderPath) {
		return corsResponse({ error: 'folderPath required' }, 400);
	}

	const workspace = await loadReminderWorkspace(env, folderPath);
	return corsResponse({
		reminders: workspace.reminders.map((reminder) => toReminderPayload(reminder)),
		projects: workspace.projects,
	});
}

export async function handleCreateReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) {
		return workspaceResult;
	}

	const project = parseOptionalString(parsedBody.value.project, 256) || 'Inbox';
	const content = parseOptionalString(parsedBody.value.content, 1024);
	if (!content) {
		return corsResponse({ error: 'content required' }, 400);
	}
	const recurrenceResult = parseRecurrenceMutationValue(parsedBody.value.recurrence);
	if (!recurrenceResult.ok) {
		return recurrenceResult.response;
	}

	const priority = parsedBody.value.priority === 1 ? 1 : 4;
	const createArgs = buildCreateReminderArgs({
		content,
		description: parseOptionalString(parsedBody.value.description, 4096) || undefined,
		project,
		priority,
		recurrence: recurrenceResult.value ?? undefined,
		dueDate: parseOptionalString(parsedBody.value.dueDate, 64) || undefined,
		dueDatetime: parseOptionalString(parsedBody.value.dueDatetime, 128) || undefined,
		id: parseOptionalString(parsedBody.value.id, 128) || undefined,
	});
	const reminderId = createArgs.reminderId || createReminderId();
	const filePath = getProjectFilePath(workspaceResult.folderPath, project);
	const existingContent = await readCommittedMarkdownFile(env.BUCKET, env.DB!, filePath)
		?? getInitialProjectFileContent(project);
	const nextContent = createReminderInFileContent(existingContent, {
		content,
		description: parseOptionalString(parsedBody.value.description, 4096) || undefined,
		dueDate: createArgs.dueDate,
		priority: createArgs.priority,
		recurrence: createArgs.recurrence,
		hasTime: createArgs.hasTime,
		reminderId,
	});
	await writeCommittedMarkdownFile(env.BUCKET, env.DB!, filePath, nextContent);

	const workspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const reminder = findReminderById(workspace, reminderId);
	const notificationWarning = reminder
		? await syncReminderNotification(env, reminder, workspaceResult.allDayNotificationTime)
		: undefined;
	return corsResponse({
		success: true,
		notificationWarning,
	});
}

export async function handleUpdateReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) {
		return workspaceResult;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) {
		return corsResponse({ error: 'id required' }, 400);
	}

	const workspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const reminder = findReminderById(workspace, id);
	if (!reminder) {
		return corsResponse({ error: 'Reminder not found' }, 404);
	}

	const updateParams: UpdateReminderParams = {};
	if (Object.prototype.hasOwnProperty.call(parsedBody.value, 'content')) {
		updateParams.content = parseOptionalString(parsedBody.value.content, 1024) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(parsedBody.value, 'description')) {
		updateParams.description = parsedBody.value.description === null
			? ''
			: parseOptionalString(parsedBody.value.description, 4096) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(parsedBody.value, 'priority')) {
		if (parsedBody.value.priority === 1 || parsedBody.value.priority === 4) {
			updateParams.priority = parsedBody.value.priority;
		} else {
			return corsResponse({ error: 'Invalid priority' }, 400);
		}
	}
	if (Object.prototype.hasOwnProperty.call(parsedBody.value, 'project')) {
		updateParams.project = parseOptionalString(parsedBody.value.project, 256) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(parsedBody.value, 'dueDate')) {
		updateParams.dueDate = parseOptionalString(parsedBody.value.dueDate, 64) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(parsedBody.value, 'dueDatetime')) {
		updateParams.dueDatetime = parseOptionalString(parsedBody.value.dueDatetime, 128) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(parsedBody.value, 'recurrence')) {
		const recurrenceResult = parseRecurrenceMutationValue(parsedBody.value.recurrence);
		if (!recurrenceResult.ok) {
			return recurrenceResult.response;
		}
		updateParams.recurrence = recurrenceResult.value ?? null;
	}

	const update = buildReminderUpdate(updateParams);

	const nextProject = update.updates.project ?? reminder.project;
	if (nextProject !== reminder.project) {
		const oldFile = workspace.files.get(reminder.filePath);
		if (!oldFile) {
			return corsResponse({ error: 'Reminder source file not found' }, 409);
		}

		const oldContent = deleteReminderFromFileContent(oldFile.content, reminder);
		await writeCommittedMarkdownFile(env.BUCKET, env.DB!, reminder.filePath, oldContent);

		const newFilePath = getProjectFilePath(workspaceResult.folderPath, nextProject);
		const newFileContent = await readCommittedMarkdownFile(env.BUCKET, env.DB!, newFilePath)
			?? getInitialProjectFileContent(nextProject);
		const movedContent = createReminderInFileContent(newFileContent, {
			content: update.updates.content ?? reminder.content,
			description: 'description' in update.updates
				? (update.updates.description?.trim() || undefined)
				: reminder.description,
			dueDate: 'dueDate' in update.updates ? update.updates.dueDate : parseStoredReminderDate(reminder),
			priority: update.updates.priority ?? reminder.priority,
			recurrence: Object.prototype.hasOwnProperty.call(update.updates, 'recurrence')
				? normalizeRecurrenceRule(update.updates.recurrence ?? undefined)
				: reminder.recurrence,
			hasTime: Object.prototype.hasOwnProperty.call(update.updates, 'hasTime')
				? update.updates.hasTime
				: reminderHasTime(reminder),
			reminderId: reminder.id,
		});
		await writeCommittedMarkdownFile(env.BUCKET, env.DB!, newFilePath, movedContent);
	} else {
		const file = workspace.files.get(reminder.filePath);
		if (!file) {
			return corsResponse({ error: 'Reminder source file not found' }, 409);
		}

		const nextContent = updateReminderInFileContent(file.content, reminder, update);
		await writeCommittedMarkdownFile(env.BUCKET, env.DB!, reminder.filePath, nextContent);
	}

	const nextWorkspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const updatedReminder = findReminderById(nextWorkspace, id);
	const notificationWarning = updatedReminder
		? await syncReminderNotification(env, updatedReminder, workspaceResult.allDayNotificationTime)
		: await cancelReminderNotification(env, id);
	return corsResponse({
		success: true,
		notificationWarning,
	});
}

export async function handleSetReminderCompleted(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) {
		return workspaceResult;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id || typeof parsedBody.value.completed !== 'boolean') {
		return corsResponse({ error: 'id and completed required' }, 400);
	}

	const workspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const reminder = findReminderById(workspace, id);
	if (!reminder) {
		return corsResponse({ error: 'Reminder not found' }, 404);
	}

	const file = workspace.files.get(reminder.filePath);
	if (!file) {
		return corsResponse({ error: 'Reminder source file not found' }, 409);
	}

	const nextContent = setReminderCompletedInFileContent(file.content, reminder, parsedBody.value.completed);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB!, reminder.filePath, nextContent);

	const nextWorkspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const updatedReminder = findReminderById(nextWorkspace, id);
	const notificationWarning = updatedReminder
		? await syncReminderNotification(env, updatedReminder, workspaceResult.allDayNotificationTime)
		: await cancelReminderNotification(env, id);
	return corsResponse({
		success: true,
		notificationWarning,
	});
}

export async function handleDeleteReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) {
		return workspaceResult;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) {
		return corsResponse({ error: 'id required' }, 400);
	}

	const workspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const reminder = findReminderById(workspace, id);
	if (!reminder) {
		return corsResponse({ error: 'Reminder not found' }, 404);
	}

	const file = workspace.files.get(reminder.filePath);
	if (!file) {
		return corsResponse({ error: 'Reminder source file not found' }, 409);
	}

	const nextContent = deleteReminderFromFileContent(file.content, reminder);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB!, reminder.filePath, nextContent);
	const notificationWarning = await cancelReminderNotification(env, id);
	return corsResponse({
		success: true,
		notificationWarning,
	});
}

export async function handleReorderReminders(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const folderPath = parseFolderPath(parsedBody.value.folderPath);
	const project = parseOptionalString(parsedBody.value.project, 256);
	const orderedIds = parseStringArray(parsedBody.value.orderedIds, 500, 128);
	if (!folderPath || !project || !orderedIds) {
		return corsResponse({ error: 'folderPath, project, and orderedIds required' }, 400);
	}

	const filePath = getProjectFilePath(folderPath, project);
	const fileContent = await readCommittedMarkdownFile(env.BUCKET, env.DB!, filePath);
	if (fileContent === null) {
		return corsResponse({ error: 'Project file not found' }, 404);
	}

	const nextContent = reorderReminderBlocksInFileContent(fileContent, orderedIds);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB!, filePath, nextContent);
	return corsResponse({ success: true });
}
