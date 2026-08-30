import { corsResponse } from '../../cors';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../../storage';
import type { Env } from '../../types';
import { parseJsonObject, parseStringArray } from '../../utils';
import { getProjectFilePath, reorderReminderBlocksInFileContent } from '../file-content';
import { parseFolderPath, parseProjectPath } from '../requests';
import { saveReminderFileCache } from '../reminder-cache';
import { scanReminderMarkdownFile } from '../scan';

export async function handleReorderReminders(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const folderPath = parseFolderPath(parsedBody.value.folderPath);
	const project = parseProjectPath(parsedBody.value.project);
	const orderedIds = parseStringArray(parsedBody.value.orderedIds, 500, 128);
	if (!folderPath || !project || !orderedIds) {
		return corsResponse({ error: 'folderPath, project, and orderedIds required' }, 400);
	}

	const filePath = getProjectFilePath(folderPath, project);
	const file = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	if (!file) return corsResponse({ error: 'Project file not found' }, 404);

	const nextContent = reorderReminderBlocksInFileContent(file.content, orderedIds);
	const write = await writeCommittedMarkdownFile(env.BUCKET, env.DB, filePath, nextContent, file.hash);
	await saveReminderFileCache(
		env.DB,
		folderPath,
		filePath,
		write.hash,
		scanReminderMarkdownFile(filePath, nextContent, folderPath),
	);
	return corsResponse({ success: true });
}
