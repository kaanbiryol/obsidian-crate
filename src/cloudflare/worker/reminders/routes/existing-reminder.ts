import { beginReminderOperation } from '../operations';
import { corsResponse } from '../../cors';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../request-validation';
import { parseReminderMutationWorkspace, parseReminderSourceFilePath } from '../requests';
import { assertUniqueReminderSources } from '../source-identity';
import { commitReminderCommand } from '../command';

/** Update, deletion and completion edit one existing reminder in its source note.
 * They validate in the same order, so a request reports the same first error. */
async function handleExistingReminder(request: Request, env: Env, operationAction: 'update' | 'delete' | 'complete',
	command: 'update' | 'delete' | 'set-completed', input?: { valid: (body: Record<string, unknown>) => boolean; required: string }): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const operation = await beginReminderOperation(env.DB, parsedBody.value, operationAction);
	if (operation instanceof Response) return operation;

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) return workspaceResult;

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id || (input && !input.valid(parsedBody.value))) return corsResponse({ error: input?.required ?? 'id required' }, 400);

	const sourceFilePath = parseReminderSourceFilePath(parsedBody.value.filePath, workspaceResult.folderPath);
	if (!sourceFilePath) {
		return corsResponse({ error: 'Valid filePath required' }, 400);
	}
	await assertUniqueReminderSources(env.DB, workspaceResult.folderPath, [id]);

	return commitReminderCommand(env, operation, command, { ...parsedBody.value, id, filePath: sourceFilePath },
		workspaceResult.folderPath, parsedBody.value);
}

export function handleUpdateReminder(request: Request, env: Env): Promise<Response> {
	return handleExistingReminder(request, env, 'update', 'update');
}

export function handleDeleteReminder(request: Request, env: Env): Promise<Response> {
	return handleExistingReminder(request, env, 'delete', 'delete');
}

export function handleSetReminderCompleted(request: Request, env: Env): Promise<Response> {
	return handleExistingReminder(request, env, 'complete', 'set-completed',
		{ valid: body => typeof body.completed === 'boolean', required: 'id and completed required' });
}
