import { validateEncryptedNotification } from '../encryption/notification-format';
import { openNotification } from '../encryption/reminder-projection';
import { readReminderKeys } from './encryption-keys';

/** A locked, evicted, or newly rotated device still displays the generic push. */
export async function decryptPushDisplay(value: unknown): Promise<{ title: string; body: string } | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// A stalled read/crypto operation must still reach showNotification. The
		// losing work is read-only, and its eventual result cannot publish a second push.
		return await Promise.race([
			(async () => {
				validateEncryptedNotification(value);
				const keys = await readReminderKeys(value.vaultId, value.scopeId);
				if (!keys || keys.notifications.id !== value.keyId) return null;
				return openNotification(value, keys.notifications, keys.vaultId, keys.scopeId);
			})(),
			new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3_000); }),
		]);
	} catch { return null; }
	finally { clearTimeout(timer); }
}
