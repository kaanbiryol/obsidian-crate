import { queryRows } from '../d1/db';
import { parseEncryptedNotification } from '../../../encryption/notification-format';
import { sha256Hex } from '../../../platform/sha256';

/** The dispatcher never delivers an occurrence this long after its due time. */
export { NOTIFICATION_DELIVERY_WINDOW_MS } from '../../../reminders/core/notification-time';

/** The occurrence and push text a projection row schedules. */
export interface SchedulePayload {
	reminderId: string;
	content: string;
	project?: string | null;
	dueDatetime: string;
}
export type NotificationOperation =
	| { id: string; operation: 'schedule'; payload: SchedulePayload }
	| { id: string; operation: 'cancel'; payload: null };
interface ExistingNotification {
	id: string;
	/** Whether the reminder has a projection row at all. */
	present: number;
	filePath: string | null;
	token: string | null;
	content: string | null;
	project: string | null;
	dueDatetime: string | null;
}

function samePayload(left: SchedulePayload | null, right: SchedulePayload): boolean {
	return left?.reminderId === right.reminderId && sameContent(left.content, right.content)
		&& (left.project || null) === (right.project || null) && left.dueDatetime === right.dueDatetime;
}

function sameContent(left: string, right: string): boolean {
	if (left === right) return true;
	const a = encryptedContentIdentity(left), b = encryptedContentIdentity(right);
	return !!a && !!b && a === b;
}

/** An encrypted notification is sealed again on each commit; its identity is what stays. */
function encryptedContentIdentity(content: string): string | null {
	try {
		const parsed = parseEncryptedNotification(content);
		return parsed ? JSON.stringify([parsed.vaultId, parsed.scopeId, parsed.keyId, parsed.reminderId, parsed.fingerprint]) : null;
	} catch { return null; }
}

/** Equal for two payloads exactly when `canReuse` would keep the row's token. */
export async function schedulePayloadKey(payload: SchedulePayload): Promise<string> {
	const content = encryptedContentIdentity(payload.content) ?? ['plain', payload.content];
	return (await sha256Hex(JSON.stringify([payload.reminderId, payload.dueDatetime, payload.project || null, content]))).slice(0, 16);
}

function canReuse(row: ExistingNotification, operation: NotificationOperation): boolean {
	if (!row.token) return false;
	if (operation.operation === 'cancel') return row.dueDatetime === null;
	return row.dueDatetime !== null && samePayload({ reminderId: row.id, content: row.content ?? '', project: row.project, dueDatetime: row.dueDatetime }, operation.payload);
}

/** Current projection and schedule of each of `ids`, and of every reminder projected from `paths`. */
export async function readExistingNotifications(db: D1Database, ids: readonly string[], paths: readonly string[] = []): Promise<Map<string, ExistingNotification>> {
	if (!ids.length && !paths.length) return new Map();
	const columns = 'p.file_path AS filePath, p.notification_token AS token, p.content, p.project, p.due_datetime AS dueDatetime';
	const rows = await queryRows<ExistingNotification>(db.prepare(`SELECT ids.value AS id, p.reminder_id IS NOT NULL AS present, ${columns}
    FROM json_each(?1) ids
    LEFT JOIN reminder_projections p ON p.reminder_id = ids.value
    UNION ALL SELECT p.reminder_id, 1, ${columns} FROM reminder_projections p
    WHERE p.file_path IN (SELECT value FROM json_each(?2)) AND p.reminder_id NOT IN (SELECT value FROM json_each(?1))`)
		.bind(JSON.stringify(ids), JSON.stringify(paths)));
	return new Map(rows.map(row => [row.id, row]));
}

/** Keep the token, and so skip the row write, when the schedule is unchanged.
 * File and policy authority still advance atomically in the projection commit. */
export function planNotificationOperations(existing: ReadonlyMap<string, ExistingNotification>, operations: NotificationOperation[], token: string) {
	return operations.map(operation => {
		const row = existing.get(operation.id);
		const reuse = row && canReuse(row, operation);
		return { ...operation, token: reuse ? row.token! : token,
			dueAt: operation.payload ? Date.parse(operation.payload.dueDatetime) : null };
	});
}
