import { createsNotificationWork, readCommitFolders } from '../sync/staging/commit-context';
import { parseJsonObject, sanitizePath } from '../http/request-validation';

/** When a coordinated route that can queue notification or Reading work arms the pass:
 * `now`, before routing; `none`, because no path it can commit queues work; or `deferred`,
 * by the route itself once it knows the request is not a receipt replay. Each is decided
 * before the commit, never from its result, so a crash after a commit still finds the alarm. */
export type NotificationArming = 'now' | 'none' | 'deferred';

const DEFERRED_ROUTES = new Set(['POST /reminders/create', 'POST /reminders/update', 'POST /reminders/set-completed',
	'DELETE /reminders/delete', 'POST /reminders/reorder']);

/** Called under the coordinator lock, which every writer of the folders read here also holds. */
export async function notificationArming(request: Request, path: string, method: string, db: D1Database): Promise<NotificationArming> {
	const route = `${method} ${path}`;
	// Reminder commands arm in `beginReminderOperation`, after the receipt check.
	if (DEFERRED_ROUTES.has(route)) return 'deferred';
	// A move never commits a reminder or Reading note: the route refuses those under this lock.
	if (route === 'POST /sync/batch-move') return 'none';
	if (route !== 'POST /sync/batch-delete' && route !== 'POST /sync/restore-version') return 'now';
	// Deletions and restores commit only the paths they name, as their routes sanitize them.
	const parsed = await parseJsonObject(request.clone());
	if (!parsed.ok) return 'now';
	const named = route === 'POST /sync/restore-version' ? [parsed.value.path]
		: Array.isArray(parsed.value.files) ? parsed.value.files.map(file => (file as { path?: unknown } | null)?.path) : [];
	const paths = named.flatMap(value => typeof value === 'string' && sanitizePath(value) ? [value] : []);
	if (!paths.length) return 'none';
	return createsNotificationWork(paths, await readCommitFolders(db)) ? 'now' : 'none';
}
