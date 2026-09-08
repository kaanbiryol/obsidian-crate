import { beginReminderOperation, reminderOperationEffects } from '../operations';
import { corsResponse } from '../../cors';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseStringArray } from '../../utils';
import { getProjectFilePath, reorderReminderBlocksInFileContent } from '../file-content';
import { parseFolderPath, parseProjectPath } from '../requests';
import { saveReminderFileCache } from '../reminder-cache';
import { scanReminderMarkdownFile } from '../scan';
import { assertUniqueReminderSources } from '../../reminder-source-identity';
import { ReminderReorderConflictError } from '@/reminders/core/markdownReminderFile';

// Paging changes only mounted rows; reorder still submits the complete project
// order. The shared JSON reader also bounds the entire request to 1 MiB.
const MAX_REORDER_REMINDERS = 10_000;

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

	const filePath = getProjectFilePath(folderPath, project);
	const file = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	if (!file) return corsResponse({ error: 'Project file not found' }, 404);

	const currentOrder = scanReminderMarkdownFile(filePath, file.content, folderPath).map(reminder => reminder.id);
	await assertUniqueReminderSources(env.DB, folderPath, currentOrder);
	if (!Array.isArray(parsedBody.value.expectedOrder)) return corsResponse({ error: 'Expected project order required. Reload before reordering.' }, 428);
	const expectedOrder = parseStringArray(parsedBody.value.expectedOrder, MAX_REORDER_REMINDERS, 128);
	if (!expectedOrder) return corsResponse({ error: 'Invalid expected project order.' }, 400);
	if (JSON.stringify(currentOrder) !== JSON.stringify(expectedOrder)) return corsResponse({ error: 'Project order changed. Reload before reordering.' }, 409);

	let nextContent: string;
	try {
		nextContent = reorderReminderBlocksInFileContent(file.content, orderedIds);
	} catch (error) {
		if (error instanceof ReminderReorderConflictError) {
			return corsResponse({ error: error.message, code: 'reminder_order_conflict' }, 409);
		}
		throw error;
	}
	const write = await writeCommittedMarkdownFile(env.BUCKET, env.DB, filePath, nextContent, file.hash,
		reminderOperationEffects(env.DB, operation, { success: true }));
	await saveReminderFileCache(
		env.DB,
		folderPath,
		filePath,
		write.hash,
		scanReminderMarkdownFile(filePath, nextContent, folderPath),
	);
	return corsResponse({ success: true });
}
