import { readCommittedMarkdownFileVersion } from '../storage';
import type { StoredTextFile } from '../storage';
import type { Env } from '../types';
import { scanReminderMarkdownFile } from './scan';
import type { RemoteReminderRecord } from './types';

export async function loadReminderSource(
	env: Env,
	folderPath: string,
	id: string,
	filePath: string,
): Promise<{ file: StoredTextFile; reminder: RemoteReminderRecord } | null> {
	const storedFile = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	if (!storedFile) return null;
	const reminder = scanReminderMarkdownFile(filePath, storedFile.content, folderPath)
		.find(candidate => candidate.id === id);
	return reminder
		? { file: { path: filePath, ...storedFile }, reminder }
		: null;
}
