import { beginReminderOperation } from '../operations';
import { corsResponse } from '../../cors';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../request-validation';
import { parseReminderMutationWorkspace, parseReminderSourceFilePath } from '../requests';
import { assertUniqueReminderSources } from '../../reminders/source-identity';
import { commitReminderCommand } from '../command';

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
	await assertUniqueReminderSources(env.DB, workspaceResult.folderPath, [id]);

	return commitReminderCommand(env, operation, 'delete', { ...parsedBody.value, id, filePath: sourceFilePath },
		workspaceResult.folderPath, parsedBody.value);
}
