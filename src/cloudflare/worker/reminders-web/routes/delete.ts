import { corsResponse } from '../../cors';
import { writeCommittedMarkdownFile } from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../utils';
import { deleteReminderFromFileContent } from '../file-content';
import { cancelReminderNotification } from '../notifications';
import { parseReminderMutationWorkspace, parseReminderSourceFilePath } from '../requests';
import { loadReminderSource } from '../workspace';

export async function handleDeleteReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) return workspaceResult;

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) return corsResponse({ error: 'id required' }, 400);

	const sourceFilePath = parseReminderSourceFilePath(parsedBody.value.filePath, workspaceResult.folderPath);
	if (parsedBody.value.filePath !== undefined && !sourceFilePath) {
		return corsResponse({ error: 'Invalid filePath' }, 400);
	}
	const source = await loadReminderSource(env, workspaceResult.folderPath, id, sourceFilePath ?? undefined);
	if (!source) return corsResponse({ error: 'Reminder not found' }, 404);
	const { file, reminder } = source;

	const nextContent = deleteReminderFromFileContent(file.content, reminder);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, nextContent, file.hash);
	const notificationWarning = await cancelReminderNotification(env, id);
	return corsResponse({ success: true, id, notificationWarning });
}
