import { expect, it, vi } from 'vitest';
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
	// An unchanged fingerprint reuses its envelope instead of encrypting again.
	expect(notice.envelope).toBe(second!.reminders[0]!.notification.envelope);
	expect(notice.fingerprint).toBe(second!.reminders[0]!.notification.fingerprint);
	const edited = await createReminderProjection(bundle, 'Reminders/Personal.md',
		new TextEncoder().encode('- [ ] Secret meeting 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->').buffer);
	expect(edited!.reminders[0]!.notification.fingerprint).not.toBe(notice.fingerprint);
	expect(edited!.reminders[0]!.notification.envelope).not.toBe(notice.envelope);
	expect(await openNotification(notice, await importEncryptionSecret(scope.notifications), bundle.vaultId, scope.id))
		.toEqual({ title: 'Secret appointment', body: 'Personal' });
	await expect(openNotification(notice, await importEncryptionSecret(scope.data), bundle.vaultId, scope.id)).rejects.toThrow();
	await expect(openNotification(notice, await importEncryptionSecret(scope.notifications), 'different', scope.id)).rejects.toThrow();
	expect(notice.envelope.length).toBeLessThanOrEqual(2800);
});

it('re-encrypts only reminders whose notification fingerprint changed', async () => {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const note = (changed: string) => new TextEncoder().encode(Array.from({ length: 20 }, (_, index) =>
		`- [ ] ${index === 0 ? changed : `Task ${index}`} @2099-01-02 <!-- crate-id:r${index} -->`).join('\n')).buffer;
	const before = await createReminderProjection(bundle, 'Reminders/Inbox.md', note('First'));
	const importKey = vi.spyOn(crypto.subtle, 'importKey');
	try {
		const after = await createReminderProjection(bundle, 'Reminders/Inbox.md', note('Edited'));
		// One envelope (two key imports). Before: 40, all 20 were encrypted again.
		expect(importKey).toHaveBeenCalledTimes(2);
		expect(after!.reminders.map(reminder => reminder.id)).toEqual(before!.reminders.map(reminder => reminder.id));
		expect(after!.reminders.slice(1)).toEqual(before!.reminders.slice(1));
	} finally { importKey.mockRestore(); }
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

it('imports a scope\'s notification keys once for many projected files', async () => {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const importKey = vi.spyOn(crypto.subtle, 'importKey');
	try {
		for (let file = 0; file < 5; file++) {
			await createReminderProjection(bundle, `Reminders/Note ${file}.md`, new TextEncoder().encode(`- [ ] Task ${file} <!-- crate-id:task-${file} -->`).buffer);
		}
		// Each notice envelope still derives its own key (two imports per file).
		// Before: 20, because the scope keys were imported again for every file.
		expect(importKey).toHaveBeenCalledTimes(2 + 5 * 2);
	} finally { importKey.mockRestore(); }
});
