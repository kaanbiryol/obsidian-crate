import { beginReminderOperation, reminderOperationEffects } from '../operations';
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
import { projectReminderNotifications } from '../notifications';
import {
	hasNonEmptyStringValue,
	parseProjectPath,
	parseRecurrenceMutationValue,
	parseReminderMutationWorkspace,
} from '../requests';
import { saveReminderFileCache } from '../reminder-cache';
import { scanReminderMarkdownFile, toReminderPayload } from '../scan';

export async function handleCreateReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const operation = await beginReminderOperation(env.DB, parsedBody.value, 'create');
	if (operation instanceof Response) return operation;
	if (parsedBody.value.id !== operation.id) return corsResponse({ error: 'A new reminder must use its operation identity.' }, 400);

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
	const reminderId = operation.id;
	const filePath = getProjectFilePath(workspaceResult.folderPath, project);
	const existingFile = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	const existingContent = existingFile?.content ?? getInitialProjectFileContent(project);
	if (scanReminderMarkdownFile(filePath, existingContent, workspaceResult.folderPath).some(reminder => reminder.id === reminderId)
		|| await env.DB.prepare('SELECT reminder_id FROM reminder_identities WHERE reminder_id = ?').bind(reminderId).first()) {
		return corsResponse({ error: 'This reminder already exists. Reload to see its committed state.' }, 409);
	}
	const nextContent = createReminderInFileContent(existingContent, {
		content,
		description,
		dueDate: createArgs.dueDate,
		priority: createArgs.priority,
		recurrence: createArgs.recurrence,
		hasTime: createArgs.hasTime,
		reminderId,
	});
	const reminders = scanReminderMarkdownFile(filePath, nextContent, workspaceResult.folderPath);
	const reminder = reminders.find(candidate => candidate.id === reminderId);
	const response = { success: true, reminder: reminder ? await toReminderPayload(reminder) : undefined };
	const write = await writeCommittedMarkdownFile(env.BUCKET, env.DB, filePath, nextContent, existingFile?.hash ?? null,
		reminderOperationEffects(env.DB, operation, response, reminderId));
	await saveReminderFileCache(env.DB, workspaceResult.folderPath, filePath, write.hash, reminders);

	const notificationWarning = await projectReminderNotifications(env);
	return corsResponse({
		success: true,
		reminder: reminder ? await toReminderPayload(reminder) : undefined,
		notificationWarning,
	});
}
