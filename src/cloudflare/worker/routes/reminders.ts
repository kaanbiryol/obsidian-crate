import { handleNotificationPolicy } from '../notifications/policy';
import { handleCreateReminder } from '../reminders/handlers/create';
import { handleDeleteReminder, handleSetReminderCompleted, handleUpdateReminder } from '../reminders/handlers/existing-reminder';
import { handleListReminders } from '../reminders/handlers/list';
import { handleReorderReminders } from '../reminders/handlers/reorder';
import { handleEncryptedFolderFiles } from '../encryption/encrypted-folder-files';
import { featureEnabled, parseStoredFeaturePolicy } from '../server/feature-policy';
import { MAX_ENCRYPTED_REMINDER_REQUEST_BYTES } from '../../../encryption/receipt-format';
import { parseJsonObject } from '../http/request-validation';
import { corsResponse } from '../http/cors';
import { REMINDERS_FOLDER_CHANGED } from '../../../protocol/web-session';
import type { Env } from '../types';
import type { AuthenticatedRouteContext } from '../router';

/** Dispatches `/reminders/` routes once the feature is on and a web session names its enrolled folder. */
export async function handleRemindersRoute(
	request: Request,
	env: Env,
	{ path, method, principal, encryption, featurePolicyValue }: Pick<AuthenticatedRouteContext, 'path' | 'method' | 'principal' | 'encryption' | 'featurePolicyValue'>,
): Promise<Response | null> {
	if (!path.startsWith('/reminders/')) return null;
	const db = env.DB;
	const enabled = featurePolicyValue === undefined ? await featureEnabled(db, 'reminders') : parseStoredFeaturePolicy(featurePolicyValue).reminders;
	if (!enabled) return corsResponse({ error: 'Reminders are paused. Enable them in Crate settings.', code: 'feature_paused' }, 423);
	if (principal.scope === 'reminders') {
		let folder: unknown = new URL(request.url).searchParams.get('folderPath');
		if (method !== 'GET') {
			const parsed = await parseJsonObject(request.clone(), path === '/reminders/encrypted-commit' ? MAX_ENCRYPTED_REMINDER_REQUEST_BYTES : undefined);
			if (!parsed.ok) return parsed.response;
			folder = parsed.value.folderPath;
		}
		if (!principal.folderPath) return corsResponse({ error: 'This session is limited to its enrolled reminders folder' }, 403);
		// Sessions follow reminders folder changes; the web app switches to the folder named here.
		if (folder !== principal.folderPath) return corsResponse({ error: 'The reminders folder changed', code: REMINDERS_FOLDER_CHANGED, folderPath: principal.folderPath }, 403);
	}
	if (path.startsWith('/reminders/encrypted-')) return handleEncryptedFolderFiles(request, env, path, 'reminders', principal.scope === 'reminders' ? principal.folderPath : undefined, encryption);
	if (path === '/reminders/notification-policy' && ['GET', 'POST', 'PUT'].includes(method)) return handleNotificationPolicy(request, db);

	if (path === '/reminders/list' && method === 'GET') {
		return await handleListReminders(request, env);
	}
	if (path === '/reminders/create' && method === 'POST') {
		return await handleCreateReminder(request, env);
	}
	if (path === '/reminders/update' && method === 'POST') {
		return await handleUpdateReminder(request, env);
	}
	if (path === '/reminders/set-completed' && method === 'POST') {
		return await handleSetReminderCompleted(request, env);
	}
	if (path === '/reminders/delete' && method === 'DELETE') {
		return await handleDeleteReminder(request, env);
	}
	if (path === '/reminders/reorder' && method === 'POST') {
		return await handleReorderReminders(request, env);
	}


	return null;
}
