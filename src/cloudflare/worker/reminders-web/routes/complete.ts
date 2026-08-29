import { corsResponse } from '../../cors';
import { writeCommittedMarkdownFile } from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../utils';
import { setReminderCompletedInFileContent } from '../file-content';
import { cancelReminderNotification, syncReminderNotification } from '../notifications';
import { parseReminderMutationWorkspace } from '../requests';
import { findReminderById, loadReminderWorkspace } from '../workspace';

export async function handleSetReminderCompleted(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) return workspaceResult;

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id || typeof parsedBody.value.completed !== 'boolean') {
		return corsResponse({ error: 'id and completed required' }, 400);
	}

	const workspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const reminder = findReminderById(workspace, id);
	if (!reminder) return corsResponse({ error: 'Reminder not found' }, 404);

	const file = workspace.files.get(reminder.filePath);
	if (!file) return corsResponse({ error: 'Reminder source file not found' }, 409);

	const nextContent = setReminderCompletedInFileContent(file.content, reminder, parsedBody.value.completed);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, nextContent, file.hash);

	const nextWorkspace = await loadReminderWorkspace(env, workspaceResult.folderPath);
	const updatedReminder = findReminderById(nextWorkspace, id);
	const notificationWarning = updatedReminder
		? await syncReminderNotification(env, updatedReminder, workspaceResult.allDayNotificationTime)
		: await cancelReminderNotification(env, id);
	return corsResponse({ success: true, notificationWarning });
}
