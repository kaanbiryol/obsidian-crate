import { corsResponse } from '../../cors';
import type { Env } from '../../types';
import { parseFolderPath } from '../requests';
import { toReminderPayload } from '../scan';
import { loadReminderWorkspace } from '../workspace';

export async function handleListReminders(request: Request, env: Env): Promise<Response> {
	const folderPath = parseFolderPath(new URL(request.url).searchParams.get('folderPath'));
	if (!folderPath) {
		return corsResponse({ error: 'folderPath required' }, 400);
	}

	const workspace = await loadReminderWorkspace(env, folderPath);
	return corsResponse({
		reminders: workspace.reminders.map(reminder => toReminderPayload(reminder)),
		projects: workspace.projects,
	});
}
