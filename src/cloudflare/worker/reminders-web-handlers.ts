import { parseStoredReminderDate, reminderHasTime } from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import type { UpdateReminderParams } from '@/reminders/types/plugin-reminder';
import { createReminderId } from '@/reminders/data/reminderIdentity';
import { buildCreateReminderArgs, buildReminderUpdate } from '@/reminders/data/storageCompatShared';
import { corsResponse } from './cors';
import { readCommittedMarkdownFile, writeCommittedMarkdownFile } from './storage';
import type { Env } from './types';
import { parseJsonObject, parseOptionalString, parseStringArray } from './utils';
import {
	createReminderInFileContent,
	deleteReminderFromFileContent,
	getInitialProjectFileContent,
	getProjectFilePath,
	reorderReminderBlocksInFileContent,
	setReminderCompletedInFileContent,
	updateReminderInFileContent,
} from './reminders-web/file-content';
import { cancelReminderNotification, syncReminderNotification } from './reminders-web/notifications';
import {
	hasNonEmptyStringValue,
	parseFolderPath,
	parseProjectPath,
	parseRecurrenceMutationValue,
	parseReminderMutationWorkspace,
} from './reminders-web/requests';
import { toReminderPayload } from './reminders-web/scan';
import { findReminderById, loadReminderWorkspace } from './reminders-web/workspace';

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

	const parsedProject = parseProjectPath(parsedBody.value.project);
	if (hasNonEmptyStringValue(parsedBody.value.project) && !parsedProject) {
		return corsResponse({ error: 'Invalid project' }, 400);
	}
	const project = parsedProject || 'Inbox';
	const content = parseOptionalString(parsedBody.value.content, 1024);
	if (!content) {
		return corsResponse({ error: 'content required' }, 400);
	}
	const recurrenceResult = parseRecurrenceMutationValue(parsedBody.value.recurrence);
	if (!recurrenceResult.ok) {
		return recurrenceResult.response;
	}

	const priority = parsedBody.value.priority === 1 ? 1 : 4;
	const description = parseOptionalString(parsedBody.value.description, 4096) || undefined;
	const createArgs = buildCreateReminderArgs({
		content,
		description,
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
		description,
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
		const parsedProject = parseProjectPath(parsedBody.value.project);
		if (hasNonEmptyStringValue(parsedBody.value.project) && !parsedProject) {
			return corsResponse({ error: 'Invalid project' }, 400);
		}
		updateParams.project = parsedProject || undefined;
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
	const project = parseProjectPath(parsedBody.value.project);
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
