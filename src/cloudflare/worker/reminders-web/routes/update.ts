import { buildReminderUpdate } from '@/reminders/data/reminder-repository/shared';
import type { UpdateReminderParams } from '@/reminders/types/plugin-reminder';
import { parseStoredReminderDate, reminderHasTime } from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { corsResponse } from '../../cors';
import {
	deleteCommittedMarkdownFile,
	readCommittedMarkdownFileVersion,
	writeCommittedMarkdownFile,
} from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../utils';
import {
	createReminderInFileContent,
	deleteReminderFromFileContent,
	getInitialProjectFileContent,
	getProjectFilePath,
	updateReminderInFileContent,
} from '../file-content';
import { cancelReminderNotification, syncReminderNotification } from '../notifications';
import {
	hasNonEmptyStringValue,
	parseProjectPath,
	parseRecurrenceMutationValue,
	parseReminderMutationWorkspace,
} from '../requests';
import { findReminderById, loadReminderWorkspace } from '../workspace';

function parseUpdateParams(body: Record<string, unknown>): UpdateReminderParams | Response {
	const updateParams: UpdateReminderParams = {};
	if (Object.prototype.hasOwnProperty.call(body, 'content')) {
		updateParams.content = parseOptionalString(body.content, 1024) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(body, 'description')) {
		updateParams.description = body.description === null
			? ''
			: parseOptionalString(body.description, 4096) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
		if (body.priority !== 1 && body.priority !== 4) {
			return corsResponse({ error: 'Invalid priority' }, 400);
		}
		updateParams.priority = body.priority;
	}
	if (Object.prototype.hasOwnProperty.call(body, 'project')) {
		const parsedProject = parseProjectPath(body.project);
		if (hasNonEmptyStringValue(body.project) && !parsedProject) {
			return corsResponse({ error: 'Invalid project' }, 400);
		}
		updateParams.project = parsedProject || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(body, 'dueDate')) {
		updateParams.dueDate = parseOptionalString(body.dueDate, 64) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(body, 'dueDatetime')) {
		updateParams.dueDatetime = parseOptionalString(body.dueDatetime, 128) || undefined;
	}
	if (Object.prototype.hasOwnProperty.call(body, 'recurrence')) {
		const recurrenceResult = parseRecurrenceMutationValue(body.recurrence);
		if (!recurrenceResult.ok) {
			return recurrenceResult.response;
		}
		updateParams.recurrence = recurrenceResult.value ?? null;
	}
	return updateParams;
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

	const updateParams = parseUpdateParams(parsedBody.value);
	if (updateParams instanceof Response) {
		return updateParams;
	}
	const update = buildReminderUpdate(updateParams);

	const nextProject = update.updates.project ?? reminder.project;
	if (nextProject !== reminder.project) {
		const oldFile = workspace.files.get(reminder.filePath);
		if (!oldFile) {
			return corsResponse({ error: 'Reminder source file not found' }, 409);
		}

		const newFilePath = getProjectFilePath(workspaceResult.folderPath, nextProject);
		const newFile = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, newFilePath);
		const newFileContent = newFile?.content ?? getInitialProjectFileContent(nextProject);
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
			completed: reminder.completed,
			reminderId: reminder.id,
		});
		const newWrite = await writeCommittedMarkdownFile(
			env.BUCKET,
			env.DB,
			newFilePath,
			movedContent,
			newFile?.hash ?? null,
		);

		try {
			const oldContent = deleteReminderFromFileContent(oldFile.content, reminder);
			await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, oldContent, oldFile.hash);
		} catch (error) {
			try {
				if (newFile) {
					await writeCommittedMarkdownFile(
						env.BUCKET,
						env.DB,
						newFilePath,
						newFile.content,
						newWrite.hash,
					);
				} else {
					await deleteCommittedMarkdownFile(env.BUCKET, env.DB, newFilePath, newWrite.hash);
				}
			} catch {
				// A newer edit won the race; never overwrite it during compensation.
			}
			throw error;
		}
	} else {
		const file = workspace.files.get(reminder.filePath);
		if (!file) {
			return corsResponse({ error: 'Reminder source file not found' }, 409);
		}

		const nextContent = updateReminderInFileContent(file.content, reminder, update);
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, nextContent, file.hash);
	}

	const nextWorkspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const updatedReminder = findReminderById(nextWorkspace, id);
	const notificationWarning = updatedReminder
		? await syncReminderNotification(env, updatedReminder, workspaceResult.allDayNotificationTime)
		: await cancelReminderNotification(env, id);
	return corsResponse({ success: true, notificationWarning });
}
