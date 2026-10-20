import { parseReminderUpdateParams } from '@/reminders/core/reminderMutationInput';
import { beginReminderOperation, reminderOperationEffects } from '../operations';
import { buildReminderUpdate } from '@/reminders/core/reminderMutationPlan';
import { writeCommittedMarkdownFilePair } from '../../sync/atomic-markdown-write';
import { corsResponse } from '../../cors';
import {
	readCommittedMarkdownFileVersion,
	writeCommittedMarkdownFile,
} from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseOptionalString } from '../../request-validation';
import {
	deleteReminderFromFileContent,
	getInitialProjectFileContent,
	getProjectFilePath,
	moveReminderIntoFileContent,
	updateReminderInFileContent,
} from '../file-content';
import {
	parseReminderMutationWorkspace,
	parseReminderSourceFilePath,
	recurrenceInputResponse,
} from '../requests';
import { saveReminderFileCache } from '../reminder-cache';
import { scanReminderMarkdownFile, toReminderPayload } from '../scan';
import { loadReminderSource } from '../workspace';
import { checkReminderRevision } from '../revision';

export async function handleUpdateReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const operation = await beginReminderOperation(env.DB, parsedBody.value, 'update');
	if (operation instanceof Response) return operation;

	const workspaceResult = parseReminderMutationWorkspace(parsedBody.value);
	if (workspaceResult instanceof Response) {
		return workspaceResult;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) {
		return corsResponse({ error: 'id required' }, 400);
	}

	const sourceFilePath = parseReminderSourceFilePath(parsedBody.value.filePath, workspaceResult.folderPath);
	if (!sourceFilePath) {
		return corsResponse({ error: 'Valid filePath required' }, 400);
	}
	const source = await loadReminderSource(env, workspaceResult.folderPath, id, sourceFilePath);
	if (!source) {
		return corsResponse({ error: 'Reminder not found' }, 404);
	}
	const { file: oldFile, reminder } = source;
	const revisionError = await checkReminderRevision(parsedBody.value, reminder);
	if (revisionError) return revisionError;

	let updateParams;
	try {
		updateParams = parseReminderUpdateParams(parsedBody.value);
	} catch (error) {
		return recurrenceInputResponse(error);
	}
	const update = buildReminderUpdate(updateParams);

	const nextProject = update.updates.project ?? reminder.project;
	let updatedReminder;
	if (nextProject !== reminder.project) {
		const newFilePath = getProjectFilePath(workspaceResult.folderPath, nextProject);
		const newFile = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, newFilePath);
		const newFileContent = newFile?.content ?? getInitialProjectFileContent(nextProject);
		const movedContent = moveReminderIntoFileContent(newFileContent, reminder, update);
		const oldContent = deleteReminderFromFileContent(oldFile.content, reminder);
		const movedReminders = scanReminderMarkdownFile(newFilePath, movedContent, workspaceResult.folderPath);
		updatedReminder = movedReminders.find(candidate => candidate.id === id);
		const response = { success: true, reminder: updatedReminder ? await toReminderPayload(updatedReminder) : undefined };
		const writes = await writeCommittedMarkdownFilePair(
			env.BUCKET,
			env.DB,
			{
				effects: reminderOperationEffects(env.DB, operation, response),
				source: {
					path: reminder.filePath,
					content: oldContent,
					expectedHash: oldFile.hash,
				},
				destination: {
					path: newFilePath,
					content: movedContent,
					expectedHash: newFile?.hash ?? null,
				},
			},
		);

		const oldReminders = scanReminderMarkdownFile(reminder.filePath, oldContent, workspaceResult.folderPath);
		await Promise.all([
			saveReminderFileCache(env.DB, workspaceResult.folderPath, newFilePath, writes.destination.hash, movedReminders),
			saveReminderFileCache(env.DB, workspaceResult.folderPath, reminder.filePath, writes.source.hash, oldReminders),
		]);
		updatedReminder = movedReminders
			.find(candidate => candidate.id === id);
	} else {
		const nextContent = updateReminderInFileContent(oldFile.content, reminder, update);
		const reminders = scanReminderMarkdownFile(reminder.filePath, nextContent, workspaceResult.folderPath);
		updatedReminder = reminders.find(candidate => candidate.id === id);
		const response = { success: true, reminder: updatedReminder ? await toReminderPayload(updatedReminder) : undefined };
		const write = await writeCommittedMarkdownFile(env.BUCKET, env.DB, reminder.filePath, nextContent, oldFile.hash,
			reminderOperationEffects(env.DB, operation, response));
		await saveReminderFileCache(env.DB, workspaceResult.folderPath, reminder.filePath, write.hash, reminders);
		updatedReminder = reminders
			.find(candidate => candidate.id === id);
	}

	return corsResponse({
		success: true,
		reminder: updatedReminder ? await toReminderPayload(updatedReminder) : undefined,
	});
}
