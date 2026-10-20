import { assertReminderMutationInput, parseReminderRecurrenceInput } from '@/reminders/core/reminderMutationInput';
import { beginReminderOperation } from '../operations';
import { corsResponse } from '../../cors';
import type { Env } from '../../types';
import { parseJsonObject } from '../../request-validation';
import {
	hasNonEmptyStringValue,
	parseProjectPath,
	parseReminderMutationWorkspace,
} from '../requests';
import { commitReminderCommand, plaintextFailureResponse } from '../command';

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

	// The shared command repeats these checks; checking first keeps the order
	// in which this route has reported invalid input.
	if (hasNonEmptyStringValue(parsedBody.value.project) && !parseProjectPath(parsedBody.value.project)) {
		return corsResponse({ error: 'Invalid project' }, 400);
	}
	assertReminderMutationInput(parsedBody.value, 'create');
	try {
		parseReminderRecurrenceInput(parsedBody.value.recurrence);
	} catch (error) {
		return plaintextFailureResponse(error, parsedBody.value);
	}

	return commitReminderCommand(env, operation, 'create', parsedBody.value, workspaceResult.folderPath);
}
