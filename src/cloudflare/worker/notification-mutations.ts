import { parseJsonObject } from './utils';

const ROUTES = new Set([
  'POST /sync/delete', 'POST /sync/batch-delete', 'POST /sync/restore-version',
  'POST /reminders/create', 'POST /reminders/update', 'POST /reminders/set-completed',
  'DELETE /reminders/delete', 'POST /reminders/reorder',
  'POST /reminders/notification-policy', 'PUT /reminders/notification-policy', 'POST /notifications/retry',
]);

/** Uploads coordinate individual Markdown commits after staging; binary changes need no wake. */
export async function affectsNotifications(request: Request): Promise<boolean> {
  const path = new URL(request.url).pathname;
  if (!ROUTES.has(`${request.method} ${path}`)) return false;
  if (!path.startsWith('/sync/')) return true;
  const body = await parseJsonObject(request.clone());
  if (!body.ok) return false; // The route returns the validation error without scheduling work.
  if (path === '/sync/batch-delete') {
    const files = body.value.files;
    return Array.isArray(files) && files.some((file: unknown) => file !== null && typeof file === 'object'
      && 'path' in file && typeof file.path === 'string' && file.path.toLowerCase().endsWith('.md'));
  }
  return typeof body.value.path === 'string' && body.value.path.toLowerCase().endsWith('.md');
}
