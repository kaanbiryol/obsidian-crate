import { beginReminderOperation, reminderOperationEffects } from '../operations';
import { corsResponse } from '../../cors';
import { writeCommittedMarkdownFile } from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../utils';
import { deleteReminderFromFileContent } from '../file-content';
import { parseReminderMutationWorkspace, parseReminderSourceFilePath } from '../requests';
import { saveReminderFileCache } from '../reminder-cache';
import { scanReminderMarkdownFile } from '../scan';
import { loadReminderSource } from '../workspace';
import { checkReminderRevision } from '../revision';

export async function handleDeleteReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const operation = await beginReminderOperation(env.DB, parsedBody.value, 'delete');
	if (operation instanceof Response) return operation;

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) return workspaceResult;

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) return corsResponse({ error: 'id required' }, 400);

	const sourceFilePath = parseReminderSourceFilePath(parsedBody.value.filePath, workspaceResult.folderPath);
	if (!sourceFilePath) {
		return corsResponse({ error: 'Valid filePath required' }, 400);
	}
	const source = await loadReminderSource(env, workspaceResult.folderPath, id, sourceFilePath);
	if (!source) return corsResponse({ error: 'Reminder not found' }, 404);
	const { file, reminder } = source;
	const revisionError = await checkReminderRevision(parsedBody.value, reminder);
	if (revisionError) return revisionError;

	const nextContent = deleteReminderFromFileContent(file.content, reminder);
	const write = await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, nextContent, file.hash,
		reminderOperationEffects(env.DB, operation, { success: true, id }));
	await saveReminderFileCache(
		env.DB,
		workspaceResult.folderPath,
		reminder.filePath,
		write.hash,
		scanReminderMarkdownFile(reminder.filePath, nextContent, workspaceResult.folderPath),
	);
	return corsResponse({ success: true, id });
}
