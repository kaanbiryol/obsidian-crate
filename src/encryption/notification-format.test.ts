import { describe, expect, it } from 'vitest';
import { encryptJson, generateEncryptionSecret, importEncryptionSecret } from './envelope';
import { ENCRYPTED_NOTIFICATION_PREFIX, parseEncryptedNotification, validateEncryptedNotification, validateEncryptedSchedules, type EncryptedNotification } from './notification-format';
import { importNotificationKeys, openNotification, sealNotification } from './notification-keys';

const notice = (reminderId = 'reminder-a'): EncryptedNotification => ({ version: 1, vaultId: 'vault-a', scopeId: 'vault', keyId: 'key-a',
	reminderId, fingerprint: 'F'.repeat(43), envelope: 'a.b.c.d.e' });
const schedule = (id = 'reminder-a') => ({ id, completed: false, dueDate: '2099-01-02', dueDatetime: '2099-01-02T09:00:00Z', notification: notice(id) });

describe('encrypted notification format', () => {
	it('parses only prefixed notifications and validates them', () => {
		expect(parseEncryptedNotification('- [ ] plaintext reminder')).toBeNull();
		expect(parseEncryptedNotification(ENCRYPTED_NOTIFICATION_PREFIX + JSON.stringify(notice()))).toEqual(notice());
		expect(() => parseEncryptedNotification(ENCRYPTED_NOTIFICATION_PREFIX + JSON.stringify({ ...notice(), version: 2 }))).toThrow('Invalid encrypted notification');
		expect(() => parseEncryptedNotification(ENCRYPTED_NOTIFICATION_PREFIX + '{')).toThrow(SyntaxError);
	});

	it.each([
		['an array', []],
		['an extra field', { ...notice(), title: 'Private title' }],
		['an invalid key ID', { ...notice(), keyId: 'a b' }],
		['a short fingerprint', { ...notice(), fingerprint: 'F'.repeat(42) }],
		['a non-JWE envelope', { ...notice(), envelope: 'a.b.c.d' }],
		['an oversized envelope', { ...notice(), envelope: 'a.b.c.d.' + 'e'.repeat(2800) }],
		['a non-string envelope', { ...notice(), envelope: 5 }],
	])('rejects a notification with %s', (_, value) => {
		expect(() => validateEncryptedNotification(value)).toThrow(/Invalid encrypted notification|Unexpected public reminder field/);
	});

	it('accepts schedules and bounded issue markers', () => {
		expect(() => validateEncryptedSchedules({ version: 1, reminders: [schedule('a'), { id: 'b', completed: true, notification: notice('b') }] })).not.toThrow();
		for (const issue of ['size', 'invalid-reminders', 'scheduling-capacity']) expect(() => validateEncryptedSchedules({ version: 1, reminders: [], issue })).not.toThrow();
	});

	it.each([
		['a missing value', undefined, 'Missing encrypted reminder scheduling metadata'],
		['an extra field', { version: 1, reminders: [], text: 'private' }, 'Unexpected public reminder field'],
		['version 2', { version: 2, reminders: [] }, 'Invalid encrypted reminder scheduling metadata'],
		['an unknown issue', { version: 1, reminders: [], issue: 'other' }, 'Invalid encrypted reminder scheduling metadata'],
		['an issue alongside schedules', { version: 1, reminders: [schedule()], issue: 'size' }, 'Invalid encrypted reminder scheduling metadata'],
		['too many schedules', { version: 1, reminders: Array.from({ length: 10_001 }, () => schedule()) }, 'Invalid encrypted reminder scheduling metadata'],
		['a non-object schedule', { version: 1, reminders: ['a'] }, 'Invalid encrypted reminder schedule'],
		['a schedule field', { version: 1, reminders: [{ ...schedule(), text: 'private' }] }, 'Unexpected public reminder field'],
		['a non-boolean completion', { version: 1, reminders: [{ ...schedule(), completed: 'no' }] }, 'Invalid encrypted reminder schedule'],
		['a malformed due date', { version: 1, reminders: [{ ...schedule(), dueDate: '2099-1-2' }] }, 'Invalid encrypted reminder schedule'],
		['an impossible due date', { version: 1, reminders: [{ ...schedule(), dueDate: '2099-13-40' }] }, 'Invalid encrypted reminder schedule'],
		['an unparseable due time', { version: 1, reminders: [{ ...schedule(), dueDatetime: 'tomorrow' }] }, 'Invalid encrypted reminder schedule'],
		['an oversized due time', { version: 1, reminders: [{ ...schedule(), dueDatetime: '2099-01-02T09:00:00Z' + ' '.repeat(30) }] }, 'Invalid encrypted reminder schedule'],
		['a damaged notification', { version: 1, reminders: [{ ...schedule(), notification: { ...notice(), version: 2 } }] }, 'Invalid encrypted notification'],
		['another reminder\'s notification', { version: 1, reminders: [{ ...schedule('a'), notification: notice('b') }] }, 'Encrypted notification identity mismatch'],
	])('rejects schedules with %s', (_, value, message) => {
		expect(() => validateEncryptedSchedules(value)).toThrow(message);
	});
});

describe('notification keys', () => {
	const keys = () => importNotificationKeys('vault-a', generateEncryptionSecret());

	it('round-trips trimmed display text and reuses the envelope for unchanged text', async () => {
		const k = await keys();
		const sealed = await sealNotification(k, { id: 'reminder-a', title: 'T'.repeat(900), body: 'Private body 🔐'.repeat(20) });
		expect(sealed.envelope).not.toContain('Private');
		const opened = await openNotification(sealed, k.key, 'vault-a');
		expect(new TextEncoder().encode(opened.title).length).toBeLessThanOrEqual(800);
		expect(opened.title.endsWith('…')).toBe(true);
		expect(new TextEncoder().encode(opened.body).length).toBeLessThanOrEqual(160);
		const again = await sealNotification(k, { id: 'reminder-a', title: 'T'.repeat(900), body: 'Private body 🔐'.repeat(20) });
		expect(again).toEqual(sealed);
		const changed = await sealNotification(k, { id: 'reminder-a', title: 'Other', body: '' });
		expect(changed.fingerprint).not.toBe(sealed.fingerprint);
		expect(await openNotification(changed, k.key, 'vault-a')).toEqual({ title: 'Other', body: '' });
	});

	it('refuses notifications from another enrollment or with a damaged display', async () => {
		const k = await keys();
		const sealed = await sealNotification(k, { id: 'reminder-a', title: 'Title', body: 'Body' });
		await expect(openNotification(sealed, k.key, 'vault-b')).rejects.toThrow('Notification belongs to another enrollment');
		await expect(openNotification({ ...sealed, scopeId: 'reminders' }, k.key, 'vault-a')).rejects.toThrow('Notification belongs to another enrollment');
		const other = await importEncryptionSecret(generateEncryptionSecret());
		await expect(openNotification(sealed, other, 'vault-a')).rejects.toThrow('Notification belongs to another enrollment');
		await expect(openNotification({ ...sealed, reminderId: 'reminder-b' }, k.key, 'vault-a')).rejects.toThrow();
		const context = { vaultId: 'vault-a', scopeId: 'vault', objectId: 'reminder-a', purpose: 'notification' as const };
		for (const display of [null, { title: 'Title' }, { title: 'Title', body: 5 }]) {
			const envelope = await encryptJson(display, k.key, context);
			await expect(openNotification({ ...sealed, envelope }, k.key, 'vault-a')).rejects.toThrow('Invalid encrypted notification display');
		}
	});
});
