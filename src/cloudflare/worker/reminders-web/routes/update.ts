import { beginReminderOperation, reminderOperationEffects } from '../operations';
import { buildReminderUpdate } from '@/reminders/data/reminder-repository/shared';
import type { UpdateReminderParams } from '@/reminders/types/plugin-reminder';
import { parseStoredReminderDate, reminderHasTime } from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { writeCommittedMarkdownFilePair } from '../../atomic-markdown-write';
import { corsResponse } from '../../cors';
import {
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
	parseReminderSourceFilePath,
} from '../requests';
import { saveReminderFileCache } from '../reminder-cache';
import { scanReminderMarkdownFile, toReminderPayload } from '../scan';
import { loadReminderSource } from '../workspace';
import { checkReminderRevision } from '../revision';

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

	const operation = await beginReminderOperation(env.DB, parsedBody.value, 'update');
	if (operation instanceof Response) return operation;

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) {
		return workspaceResult;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) {
		return corsResponse({ error: 'id required' }, 400);
	}

	const sourceFilePath = parseReminderSourceFilePath(parsedBody.value.filePath, workspaceResult.folderPath);
	if (!sourceFilePath) {
		return corsResponse({ error: 'Valid filePath required' }, 400);
	}
	const source = await loadReminderSource(env, workspaceResult.folderPath, id, sourceFilePath);
	if (!source) {
		return corsResponse({ error: 'Reminder not found' }, 404);
	}
	const { file: oldFile, reminder } = source;
	const revisionError = await checkReminderRevision(parsedBody.value, reminder);
	if (revisionError) return revisionError;

	const updateParams = parseUpdateParams(parsedBody.value);
	if (updateParams instanceof Response) {
		return updateParams;
	}
	const update = buildReminderUpdate(updateParams);

	const nextProject = update.updates.project ?? reminder.project;
	let updatedReminder;
	if (nextProject !== reminder.project) {
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
		const oldContent = deleteReminderFromFileContent(oldFile.content, reminder);
		const movedReminders = scanReminderMarkdownFile(newFilePath, movedContent, workspaceResult.folderPath);
		updatedReminder = movedReminders.find(candidate => candidate.id === id);
		const response = { success: true, reminder: updatedReminder ? await toReminderPayload(updatedReminder) : undefined };
		const writes = await writeCommittedMarkdownFilePair(
			env.BUCKET,
			env.DB,
			{
				effects: reminderOperationEffects(env.DB, operation, response),
				source: {
					path: reminder.filePath,
					content: oldContent,
					expectedHash: oldFile.hash,
				},
				destination: {
					path: newFilePath,
					content: movedContent,
					expectedHash: newFile?.hash ?? null,
				},
			},
		);

		const oldReminders = scanReminderMarkdownFile(reminder.filePath, oldContent, workspaceResult.folderPath);
		await Promise.all([
			saveReminderFileCache(env.DB, workspaceResult.folderPath, newFilePath, writes.destination.hash, movedReminders),
			saveReminderFileCache(env.DB, workspaceResult.folderPath, reminder.filePath, writes.source.hash, oldReminders),
		]);
		updatedReminder = movedReminders
			.find(candidate => candidate.id === id);
	} else {
		const nextContent = updateReminderInFileContent(oldFile.content, reminder, update);
		const reminders = scanReminderMarkdownFile(reminder.filePath, nextContent, workspaceResult.folderPath);
		updatedReminder = reminders.find(candidate => candidate.id === id);
		const response = { success: true, reminder: updatedReminder ? await toReminderPayload(updatedReminder) : undefined };
		const write = await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, nextContent, oldFile.hash,
			reminderOperationEffects(env.DB, operation, response));
		await saveReminderFileCache(env.DB, workspaceResult.folderPath, reminder.filePath, write.hash, reminders);
		updatedReminder = reminders
			.find(candidate => candidate.id === id);
	}

	const notificationWarning = updatedReminder
		? await syncReminderNotification(env, updatedReminder, workspaceResult.allDayNotificationTime)
		: await cancelReminderNotification(env, id);
	return corsResponse({
		success: true,
		reminder: updatedReminder ? await toReminderPayload(updatedReminder) : undefined,
		notificationWarning,
	});
}
