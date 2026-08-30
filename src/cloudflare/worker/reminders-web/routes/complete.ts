import { corsResponse } from '../../cors';
import { writeCommittedMarkdownFile } from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../utils';
import { setReminderCompletedInFileContent } from '../file-content';
import { cancelReminderNotification, syncReminderNotification } from '../notifications';
import { parseReminderMutationWorkspace, parseReminderSourceFilePath } from '../requests';
import { scanReminderMarkdownFile, toReminderPayload } from '../scan';
import { loadReminderSource } from '../workspace';

export async function handleSetReminderCompleted(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) return workspaceResult;

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id || typeof parsedBody.value.completed !== 'boolean') {
		return corsResponse({ error: 'id and completed required' }, 400);
	}

	const sourceFilePath = parseReminderSourceFilePath(parsedBody.value.filePath, workspaceResult.folderPath);
	if (parsedBody.value.filePath !== undefined && !sourceFilePath) {
		return corsResponse({ error: 'Invalid filePath' }, 400);
	}
	const source = await loadReminderSource(env, workspaceResult.folderPath, id, sourceFilePath ?? undefined);
	if (!source) return corsResponse({ error: 'Reminder not found' }, 404);
	const { file, reminder } = source;

	const nextContent = setReminderCompletedInFileContent(file.content, reminder, parsedBody.value.completed);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, nextContent, file.hash);

	const updatedReminder = scanReminderMarkdownFile(reminder.filePath, nextContent, workspaceResult.folderPath)
		.find(candidate => candidate.id === id);
	const notificationWarning = updatedReminder
		? await syncReminderNotification(env, updatedReminder, workspaceResult.allDayNotificationTime)
		: await cancelReminderNotification(env, id);
	return corsResponse({
		success: true,
		reminder: updatedReminder ? toReminderPayload(updatedReminder) : undefined,
		notificationWarning,
	});
}
