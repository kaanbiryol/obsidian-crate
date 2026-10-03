import { expect, it } from 'vitest';
import { addReminderScope, createVaultKeyBundle } from './key-bundle';
import { createReminderProjection, openNotification } from './reminder-projection';
import { importEncryptionSecret } from './envelope';
import { validateEncryptedSchedules } from './notification-format';
import { FileKeyAuthority } from './file-authority';
import { openFile, sealFile } from './file-codec';

it('publishes scheduling facts without reminder text and decrypts only with the notification grant', async () => {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const scope = bundle.scopes[0]!;
	const bytes = new TextEncoder().encode('- [ ] Secret appointment 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->').buffer;
	const first = await createReminderProjection(bundle, 'Reminders/Personal.md', bytes);
	const second = await createReminderProjection(bundle, 'Reminders/Personal.md', bytes);
	validateEncryptedSchedules(first);
	expect(first.reminders).toHaveLength(1);
	expect(JSON.stringify(first)).not.toContain('Secret appointment');
	expect(JSON.stringify(first)).not.toContain('Personal');
	expect(first.reminders[0]?.dueDatetime).toBe('2099-01-02T10:00:00.000Z');
	const notice = first.reminders[0]!.notification;
	expect(notice.envelope).not.toBe(second!.reminders[0]!.notification.envelope);
	expect(notice.fingerprint).toBe(second!.reminders[0]!.notification.fingerprint);
	expect(await openNotification(notice, await importEncryptionSecret(scope.notifications), bundle.vaultId, scope.id))
		.toEqual({ title: 'Secret appointment', body: 'Personal' });
	await expect(openNotification(notice, await importEncryptionSecret(scope.data), bundle.vaultId, scope.id)).rejects.toThrow();
	await expect(openNotification(notice, await importEncryptionSecret(scope.notifications), 'different', scope.id)).rejects.toThrow();
	expect(notice.envelope.length).toBeLessThanOrEqual(2800);
});

it('quarantines invalid and oversize notes instead of cancelling their existing schedules', async () => {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const invalid = new TextEncoder().encode('- [ ] Private task tomorrow <!-- crate-id:r1 -->').buffer;
	expect(await createReminderProjection(bundle, 'Reminders/Inbox.md', invalid)).toEqual({ version: 1, reminders: [], issue: 'invalid-reminders' });
	expect(await createReminderProjection(bundle, 'Reminders/Large.md', new ArrayBuffer(1024 * 1024 + 1))).toEqual({ version: 1, reminders: [], issue: 'size' });
	expect(await createReminderProjection(bundle, 'Outside.md', invalid)).toBeNull();
});

it.each([3000, 10001])('keeps a %i-reminder note convertible when notification metadata exceeds its budget', async count => {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const path = 'Reminders/Inbox.md';
	const content = new TextEncoder().encode(Array.from({ length: count }, (_, index) => `- [ ] Private task ${index} @2099-01-02 <!-- crate-id:r${index} -->`).join('\n'));
	expect(content.byteLength).toBeLessThan(1024 * 1024);
	const publicData = await createReminderProjection(bundle, path, content.buffer);
	expect(publicData).toEqual({ version: 1, reminders: [], issue: 'scheduling-capacity' });
	validateEncryptedSchedules(publicData);
	const authority = (await FileKeyAuthority.fromVault(bundle)).forPath(path);
	const file = await sealFile({ path, content, contentType: 'text/markdown', publicData }, authority);
	const opened = await openFile(file.bytes, path, authority);
	expect(opened.content).toEqual(content);
	expect(opened.publicData).toEqual(publicData);
}, 15000);
