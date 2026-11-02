import { decryptJson, encryptJson, importEncryptionSecret, type EncryptionKey, type EncryptionSecret } from './envelope';
import { validateEncryptedNotification, type EncryptedNotification } from './notification-format';
import { decodeBase64Url, encodeBase64Url } from './encoding';

function context(notice: Pick<EncryptedNotification, 'vaultId' | 'scopeId' | 'reminderId'>) {
	return { vaultId: notice.vaultId, scopeId: notice.scopeId, objectId: notice.reminderId, purpose: 'notification' as const };
}

function trimDisplay(value: string, budget: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(value).length <= budget) return value;
	let result = '';
	let length = 0;
	for (const point of value) {
		length += encoder.encode(point).length;
		if (length > budget - 3) break;
		result += point;
	}
	return result + '…';
}

/** Notification keys share the vault-level `'vault'` scope used by every envelope. */
const NOTIFICATION_SCOPE = 'vault';

export interface NotificationKeys { vaultId: string; key: EncryptionKey; fingerprint: CryptoKey }

export async function importNotificationKeys(vaultId: string, secret: EncryptionSecret): Promise<NotificationKeys> {
	return { vaultId, key: await importEncryptionSecret(secret), fingerprint: await importNotificationFingerprintKey(vaultId, secret) };
}

export async function importNotificationFingerprintKey(vaultId: string, secret: EncryptionSecret): Promise<CryptoKey> {
	const raw = decodeBase64Url(secret.secret, 32);
	const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	raw.fill(0);
	return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
		salt: new TextEncoder().encode(vaultId), info: new TextEncoder().encode(`crate-e2ee-v1/notification-fingerprint/${NOTIFICATION_SCOPE}`) },
		material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
}

const MAX_CACHED_ENVELOPES = 4096;
/** Recent envelopes per notification key, by context and fingerprint. The server
 * already sees when a fingerprint is unchanged, so reusing that ciphertext for
 * identical display text reveals nothing new and skips re-encrypting it. */
const notificationEnvelopes = new WeakMap<EncryptionKey, Map<string, string>>();

/** Seals one reminder's notification text, trimmed to the display budget. */
export async function sealNotification(keys: NotificationKeys,
	reminder: { id: string; title: string; body: string }): Promise<EncryptedNotification> {
	const { vaultId, key, fingerprint: fingerprintKey } = keys;
	const notice: EncryptedNotification = { version: 1, vaultId, scopeId: NOTIFICATION_SCOPE,
		keyId: key.id, reminderId: reminder.id, fingerprint: '', envelope: '' };
	const display = { title: trimDisplay(reminder.title, 800),
		body: trimDisplay(reminder.body, 160) };
	while (new TextEncoder().encode(JSON.stringify(display)).length > 1024) display.title = Array.from(display.title).slice(0, -1).join('');
	notice.fingerprint = encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', fingerprintKey,
		new TextEncoder().encode(JSON.stringify([reminder.id, display])))));
	let envelopes = notificationEnvelopes.get(key);
	if (!envelopes) notificationEnvelopes.set(key, envelopes = new Map<string, string>());
	const cacheKey = JSON.stringify([vaultId, reminder.id, notice.fingerprint]);
	const cached = envelopes.get(cacheKey);
	if (cached !== undefined) {
		envelopes.delete(cacheKey);
		notice.envelope = cached;
	} else {
		notice.envelope = await encryptJson(display, key, context(notice));
	}
	envelopes.set(cacheKey, notice.envelope);
	while (envelopes.size > MAX_CACHED_ENVELOPES) envelopes.delete(envelopes.keys().next().value!);
	validateEncryptedNotification(notice);
	return notice;
}

export async function openNotification(notice: EncryptedNotification, key: EncryptionKey, vaultId: string): Promise<{ title: string; body: string }> {
	validateEncryptedNotification(notice);
	if (notice.vaultId !== vaultId || notice.scopeId !== NOTIFICATION_SCOPE || notice.keyId !== key.id) throw new Error('Notification belongs to another enrollment');
	const display = await decryptJson(notice.envelope, key, context(notice));
	if (!display || typeof display !== 'object' || !('title' in display) || !('body' in display)
		|| typeof display.title !== 'string' || typeof display.body !== 'string') throw new Error('Invalid encrypted notification display');
	return { title: display.title, body: display.body };
}
