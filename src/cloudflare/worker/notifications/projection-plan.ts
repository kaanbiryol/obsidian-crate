import { queryRows } from '../d1/db';
import { parseEncryptedNotification } from '../../../encryption/notification-format';

/** The dispatcher never delivers an occurrence this long after its due time. */
export const NOTIFICATION_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The occurrence and push text a projection row schedules. */
interface SchedulePayload {
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
	try {
		const a = parseEncryptedNotification(left), b = parseEncryptedNotification(right);
		return !!a && !!b && a.vaultId === b.vaultId && a.scopeId === b.scopeId && a.keyId === b.keyId
			&& a.reminderId === b.reminderId && a.fingerprint === b.fingerprint;
	} catch { return false; }
}

function canReuse(row: ExistingNotification, operation: NotificationOperation): boolean {
	if (!row.token) return false;
	if (operation.operation === 'cancel') return row.dueDatetime === null;
	return row.dueDatetime !== null && samePayload({ reminderId: row.id, content: row.content ?? '', project: row.project, dueDatetime: row.dueDatetime }, operation.payload);
}

/** Current projection and schedule of each reminder. */
export async function readExistingNotifications(db: D1Database, ids: readonly string[]): Promise<Map<string, ExistingNotification>> {
	if (!ids.length) return new Map();
	const rows = await queryRows<ExistingNotification>(db.prepare(`SELECT ids.value AS id,
    p.notification_token AS token, p.content, p.project, p.due_datetime AS dueDatetime
    FROM json_each(?) ids
    LEFT JOIN reminder_projections p ON p.reminder_id = ids.value`)
		.bind(JSON.stringify(ids)));
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
