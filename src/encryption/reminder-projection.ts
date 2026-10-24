import { scanReminderMarkdownContent } from '../reminders/core/markdownScan';
import { decodeMarkdownBytes } from '../reminders/core/markdownEncoding';
import { readableLinkText } from '../reminders/core/grammar/markdownLinks';
import { MAX_REMINDER_NOTE_BYTES, MAX_REMINDERS_PER_NOTE } from '../reminders/core/constants';
import { decryptJson, encryptJson, importEncryptionSecret, type EncryptionKey, type EncryptionSecret } from './envelope';
import { validateEncryptedNotification, type EncryptedNotification, type EncryptedSchedules } from './notification-format';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import { MAX_ENCRYPTED_PUBLIC_DATA_BYTES } from './file-format';

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

const NOTIFICATION_CONCURRENCY = 8;
const MAX_CACHED_ENVELOPES = 4096;
/** Recent envelopes per notification key, by context and fingerprint. The server
 * already sees when a fingerprint is unchanged, so reusing that ciphertext for
 * identical display text reveals nothing new and skips re-encrypting it. */
const notificationEnvelopes = new WeakMap<EncryptionKey, Map<string, string>>();

async function sealNotification(vaultId: string, key: EncryptionKey, fingerprintKey: CryptoKey,
	reminder: { id: string; content: string; project: string }): Promise<EncryptedNotification> {
	const notice: EncryptedNotification = { version: 1, vaultId, scopeId: NOTIFICATION_SCOPE,
		keyId: key.id, reminderId: reminder.id, fingerprint: '', envelope: '' };
	const display = { title: trimDisplay(readableLinkText(reminder.content), 800),
		body: trimDisplay(readableLinkText(reminder.project), 160) };
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

/** Publish only the current occurrence; recurrence advances on client completion.
 * Only notes inside a reminders folder carry schedules. Invalid Markdown
 * preserves the server's existing schedules via quarantine. */
export async function createReminderProjection(keys: NotificationKeys, folders: readonly string[], path: string, bytes: ArrayBuffer): Promise<EncryptedSchedules | null> {
	const folder = folders.filter(folder => folder && path.startsWith(`${folder}/`)).sort((left, right) => right.length - left.length)[0];
	if (!folder || !path.toLowerCase().endsWith('.md')) return null;
	if (bytes.byteLength > MAX_REMINDER_NOTE_BYTES) return { version: 1, reminders: [], issue: 'size' };
	let scanned;
	try { scanned = scanReminderMarkdownContent(path, decodeMarkdownBytes(bytes), folder).reminders; }
	catch { return { version: 1, reminders: [], issue: 'invalid-reminders' }; }
	if (scanned.length > MAX_REMINDERS_PER_NOTE) return { version: 1, reminders: [], issue: 'scheduling-capacity' };
	const reminders: EncryptedSchedules['reminders'] = [];
	let projectionBytes = new TextEncoder().encode(JSON.stringify({ version: 1, reminders: [] })).byteLength;
	for (let offset = 0; offset < scanned.length; offset += NOTIFICATION_CONCURRENCY) {
		const chunk = scanned.slice(offset, offset + NOTIFICATION_CONCURRENCY);
		const notices = await Promise.all(chunk.map(reminder => sealNotification(keys.vaultId, keys.key, keys.fingerprint, reminder)));
		for (const [index, reminder] of chunk.entries()) {
			const schedule = { id: reminder.id, completed: reminder.completed,
				...(reminder.dueDate ? { dueDate: reminder.dueDate } : {}),
				...(reminder.dueDatetime ? { dueDatetime: reminder.dueDatetime } : {}), notification: notices[index]! };
			projectionBytes += new TextEncoder().encode(JSON.stringify(schedule)).byteLength + (reminders.length ? 1 : 0);
			// Optional scheduling must not prevent encrypting and syncing the vault
			// file, including while converting an existing large reminders note.
			if (projectionBytes > MAX_ENCRYPTED_PUBLIC_DATA_BYTES) return { version: 1, reminders: [], issue: 'scheduling-capacity' };
			reminders.push(schedule);
		}
	}
	return { version: 1, reminders };
}

export async function openNotification(notice: EncryptedNotification, key: EncryptionKey, vaultId: string): Promise<{ title: string; body: string }> {
	validateEncryptedNotification(notice);
	if (notice.vaultId !== vaultId || notice.scopeId !== NOTIFICATION_SCOPE || notice.keyId !== key.id) throw new Error('Notification belongs to another enrollment');
	const display = await decryptJson(notice.envelope, key, context(notice));
	if (!display || typeof display !== 'object' || !('title' in display) || !('body' in display)
		|| typeof display.title !== 'string' || typeof display.body !== 'string') throw new Error('Invalid encrypted notification display');
	return { title: display.title, body: display.body };
}
