import { scanReminderMarkdownContent } from '../reminders/core/markdownScan';
import { decodeMarkdownBytes } from '../reminders/core/markdownEncoding';
import { readableLinkText } from '../reminders/utils/markdownLinks';
import { decryptJson, encryptJson, importEncryptionSecret, type EncryptionKey } from './envelope';
import type { ReminderKeyGrant, VaultKeyBundle, ScopeKeys } from './key-bundle';
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

/** Publish only the current occurrence; recurrence advances on client completion.
 * Invalid Markdown preserves the server's existing schedules via quarantine. */
export async function createReminderProjection(bundle: VaultKeyBundle | ReminderKeyGrant, path: string, bytes: ArrayBuffer): Promise<EncryptedSchedules | null> {
	const scopes = 'scopes' in bundle ? bundle.scopes : [bundle.scope];
	const scope = scopes.filter(scope => path.startsWith(`${scope.folderPath}/`))
		.sort((left, right) => right.folderPath.length - left.folderPath.length)[0];
	if (!scope || scope.purpose === 'reading' || !path.toLowerCase().endsWith('.md')) return null;
	return createReminderProjectionWithKeys(bundle.vaultId, scope, await importEncryptionSecret(scope.notifications),
		await importNotificationFingerprintKey(bundle.vaultId, scope), path, bytes);
}

export async function importNotificationFingerprintKey(vaultId: string, scope: ScopeKeys): Promise<CryptoKey> {
	const raw = decodeBase64Url(scope.notifications.secret, 32);
	const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	raw.fill(0);
	return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
		salt: new TextEncoder().encode(vaultId), info: new TextEncoder().encode(`crate-e2ee-v1/notification-fingerprint/${scope.id}`) },
		material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
}

export async function createReminderProjectionWithKeys(vaultId: string, scope: Pick<ScopeKeys, 'id' | 'folderPath'>,
	key: EncryptionKey, fingerprintKey: CryptoKey, path: string, bytes: ArrayBuffer): Promise<EncryptedSchedules | null> {
	if (!path.startsWith(`${scope.folderPath}/`) || !path.toLowerCase().endsWith('.md')) return null;
	if (bytes.byteLength > 1024 * 1024) return { version: 1, reminders: [], issue: 'size' };
	let scanned;
	try { scanned = scanReminderMarkdownContent(path, decodeMarkdownBytes(bytes), scope.folderPath).reminders; }
	catch { return { version: 1, reminders: [], issue: 'invalid-reminders' }; }
	if (scanned.length > 10_000) return { version: 1, reminders: [], issue: 'scheduling-capacity' };
	const reminders: EncryptedSchedules['reminders'] = [];
	let projectionBytes = new TextEncoder().encode(JSON.stringify({ version: 1, reminders: [] })).byteLength;
	for (const reminder of scanned) {
		const notice: EncryptedNotification = { version: 1, vaultId, scopeId: scope.id,
			keyId: key.id, reminderId: reminder.id, fingerprint: '', envelope: '' };
		const display = { title: trimDisplay(readableLinkText(reminder.content), 800),
			body: trimDisplay(readableLinkText(reminder.project), 160) };
		while (new TextEncoder().encode(JSON.stringify(display)).length > 1024) display.title = Array.from(display.title).slice(0, -1).join('');
		notice.fingerprint = encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', fingerprintKey,
			new TextEncoder().encode(JSON.stringify([reminder.id, display])))));
		notice.envelope = await encryptJson(display, key, context(notice));
		validateEncryptedNotification(notice);
		const schedule = { id: reminder.id, completed: reminder.completed,
			...(reminder.dueDate ? { dueDate: reminder.dueDate } : {}),
			...(reminder.dueDatetime ? { dueDatetime: reminder.dueDatetime } : {}), notification: notice };
		projectionBytes += new TextEncoder().encode(JSON.stringify(schedule)).byteLength + (reminders.length ? 1 : 0);
		// Optional scheduling must not prevent encrypting and syncing the vault
		// file, including while converting an existing large reminders note.
		if (projectionBytes > MAX_ENCRYPTED_PUBLIC_DATA_BYTES) return { version: 1, reminders: [], issue: 'scheduling-capacity' };
		reminders.push(schedule);
	}
	return { version: 1, reminders };
}

export async function openNotification(notice: EncryptedNotification, key: EncryptionKey, vaultId: string, scopeId: string): Promise<{ title: string; body: string }> {
	validateEncryptedNotification(notice);
	if (notice.vaultId !== vaultId || notice.scopeId !== scopeId || notice.keyId !== key.id) throw new Error('Notification belongs to another enrollment');
	const display = await decryptJson(notice.envelope, key, context(notice));
	if (!display || typeof display !== 'object' || !('title' in display) || !('body' in display)
		|| typeof display.title !== 'string' || typeof display.body !== 'string') throw new Error('Invalid encrypted notification display');
	return { title: display.title, body: display.body };
}
