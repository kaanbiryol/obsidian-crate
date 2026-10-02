const ROUTES = new Set([
  'POST /notifications/reminders-enrollment-token', 'POST /notifications/subscribe', 'DELETE /notifications/subscribe',
  'DELETE /auth/tokens', 'DELETE /auth/session',
  'POST /sync/checkpoints',
  'POST /sync/import/prune',
  'PUT /settings',
  'POST /reminders/encrypted-commit',
  'POST /sync/import/complete',
  'POST /sync/delete', 'POST /sync/batch-delete', 'POST /sync/restore-version',
  'POST /reminders/create', 'POST /reminders/update', 'POST /reminders/set-completed',
  'DELETE /reminders/delete', 'POST /reminders/reorder',
  'POST /reminders/notification-policy', 'PUT /reminders/notification-policy', 'POST /notifications/retry',
]);

/** Uploads coordinate individual Markdown commits after staging; binary changes need no wake. */
export async function affectsNotifications(request: Request): Promise<boolean> {
  const path = new URL(request.url).pathname;
  if (path === '/encryption/reset' || path.startsWith('/encryption/conversion')) return true;
  return ROUTES.has(`${request.method} ${path}`);
}
