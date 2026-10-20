import { beginReminderOperation } from '../operations';
import { corsResponse } from '../../cors';
import type { Env } from '../../types';
import { parseJsonObject, parseStringArray } from '../../request-validation';
import { parseFolderPath, parseProjectPath } from '../requests';
import { commitReminderCommand, MAX_REORDER_REMINDERS } from '../command';

export async function handleReorderReminders(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const operation = await beginReminderOperation(env.DB, parsedBody.value, 'reorder');
	if (operation instanceof Response) return operation;

	const folderPath = parseFolderPath(parsedBody.value.folderPath);
	const project = parseProjectPath(parsedBody.value.project);
	const orderedIds = parseStringArray(parsedBody.value.orderedIds, MAX_REORDER_REMINDERS, 128);
	if (!folderPath || !project || !orderedIds) {
		return corsResponse({ error: 'folderPath, project, and orderedIds required' }, 400);
	}

	// An unreadable expected order never matches the note; the failure response
	// reports why from the original request.
	const expectedOrder = parseStringArray(parsedBody.value.expectedOrder, MAX_REORDER_REMINDERS, 128);
	return commitReminderCommand(env, operation, 'reorder', { ...parsedBody.value, project, orderedIds, expectedOrder },
		folderPath, parsedBody.value);
}
