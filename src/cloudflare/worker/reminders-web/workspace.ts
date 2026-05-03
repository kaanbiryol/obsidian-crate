import { listStoredMarkdownFilesByPrefix } from '../storage';
import type { Env } from '../types';
import { getProjectFromPath, scanReminderMarkdownFile } from './scan';
import type { ReminderWorkspace, RemoteReminderRecord } from './types';

export async function loadReminderWorkspace(env: Env, folderPath: string): Promise<ReminderWorkspace> {
	const files = await listStoredMarkdownFilesByPrefix(env.BUCKET, env.DB!, folderPath);
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

export function findReminderById(workspace: ReminderWorkspace, id: string): RemoteReminderRecord | undefined {
	return workspace.reminders.find((reminder) => reminder.id === id);
}
