import {
	listStoredMarkdownFileMetadataByPrefix,
	readCommittedMarkdownFileVersion,
	readStoredMarkdownFiles,
} from '../storage';
import type { StoredMarkdownFileMetadata, StoredTextFile } from '../storage';
import type { Env } from '../types';
import { getProjectFromPath, scanReminderMarkdownFile } from './scan';
import type { ReminderWorkspace, RemoteReminderRecord } from './types';

export async function loadReminderWorkspace(
	env: Env,
	folderPath: string,
	metadata?: StoredMarkdownFileMetadata[],
): Promise<ReminderWorkspace> {
	const fileMetadata = metadata ?? await listStoredMarkdownFileMetadataByPrefix(env.DB, folderPath);
	const files = await readStoredMarkdownFiles(env.BUCKET, fileMetadata);
	const fileMap = new Map(files.map((file) => [file.path, file] as const));
	const reminders = files.flatMap((file) => scanReminderMarkdownFile(file.path, file.content, folderPath));
	const projects = Array.from(new Set(files.map((file) => getProjectFromPath(file.path, folderPath)))).sort((a, b) =>
		a.localeCompare(b),
	);
	return {
		folderPath,
		files: fileMap,
		reminders,
		projects,
	};
}

function findReminderById(workspace: ReminderWorkspace, id: string): RemoteReminderRecord | undefined {
	return workspace.reminders.find((reminder) => reminder.id === id);
}

export async function loadReminderSource(
	env: Env,
	folderPath: string,
	id: string,
	filePath?: string,
): Promise<{ file: StoredTextFile; reminder: RemoteReminderRecord } | null> {
	if (!filePath) {
		const workspace = await loadReminderWorkspace(env, folderPath);
		const reminder = findReminderById(workspace, id);
		const file = reminder ? workspace.files.get(reminder.filePath) : undefined;
		return reminder && file ? { file, reminder } : null;
	}

	const storedFile = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	if (!storedFile) return null;
	const reminder = scanReminderMarkdownFile(filePath, storedFile.content, folderPath)
		.find(candidate => candidate.id === id);
	return reminder
		? { file: { path: filePath, ...storedFile }, reminder }
		: null;
}
