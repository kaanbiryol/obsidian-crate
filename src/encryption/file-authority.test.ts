import { expect, it } from 'vitest';
import { addReminderScope, createReminderKeyGrant, createVaultKeyBundle } from './key-bundle';
import { FileKeyAuthority } from './file-authority';
import { openFile, sealFile } from './file-codec';

it('grants whole notes within one folder without granting sibling or vault files', async () => {
	const bundle = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Private');
	const vault = await FileKeyAuthority.fromVault(bundle);
	const pwa = await FileKeyAuthority.fromReminderGrant(createReminderKeyGrant(bundle, 'Reminders'));
	const path = 'Reminders/Work/Inbox.md';
	const content = new TextEncoder().encode('A whole note, including non-reminder text');
	const sealed = await sealFile({ path, content, contentType: 'text/markdown' }, vault.forPath(path));
	expect((await openFile(sealed.bytes, path, pwa.forPath(path))).content).toEqual(content);
	for (const denied of ['Private/Secret.md', 'Reminders-other/Inbox.md', 'vault.md', 'Reminders/../Private/Secret.md', '/Reminders/Inbox.md']) {
		expect(() => pwa.forPath(denied)).toThrow();
	}
	const foreign = await FileKeyAuthority.fromReminderGrant(createReminderKeyGrant(bundle, 'Private'));
	await expect(openFile(sealed.bytes, path, foreign.forPath('Private/Secret.md'))).rejects.toThrow();
});
