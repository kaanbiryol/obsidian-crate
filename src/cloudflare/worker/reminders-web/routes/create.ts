import { createReminderId } from '@/reminders/core/reminderIdentity';
import { buildCreateReminderArgs } from '@/reminders/data/reminder-repository/shared';
import { corsResponse } from '../../cors';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../utils';
import {
	createReminderInFileContent,
	getInitialProjectFileContent,
	getProjectFilePath,
} from '../file-content';
import { syncReminderNotification } from '../notifications';
import {
	hasNonEmptyStringValue,
	parseProjectPath,
	parseRecurrenceMutationValue,
	parseReminderMutationWorkspace,
} from '../requests';
import { findReminderById, loadReminderWorkspace } from '../workspace';

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
	const existingFile = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	const existingContent = existingFile?.content ?? getInitialProjectFileContent(project);
	const nextContent = createReminderInFileContent(existingContent, {
		content,
		description,
		dueDate: createArgs.dueDate,
		priority: createArgs.priority,
		recurrence: createArgs.recurrence,
		hasTime: createArgs.hasTime,
		reminderId,
	});
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, filePath, nextContent, existingFile?.hash ?? null);

	const workspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const reminder = findReminderById(workspace, reminderId);
	const notificationWarning = reminder
		? await syncReminderNotification(env, reminder, workspaceResult.allDayNotificationTime)
		: undefined;
	return corsResponse({ success: true, notificationWarning });
}
