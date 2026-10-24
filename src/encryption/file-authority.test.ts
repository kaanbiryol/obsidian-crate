import { expect, it } from 'vitest';
import { createVaultKeyBundle } from './key-bundle';
import { importEncryptionSecret } from './envelope';
import { FileKeyAuthority } from './file-authority';
import { openFile, sealFile } from './file-codec';

it('opens every vault note with the vault key and refuses unsafe paths or another vault key', async () => {
	const bundle = await createVaultKeyBundle();
	const vault = await FileKeyAuthority.fromBundle(bundle);
	const pwa = FileKeyAuthority.fromKey(bundle.vaultId, await importEncryptionSecret(bundle.vault));
	const path = 'Reminders/Work/Inbox.md';
	const content = new TextEncoder().encode('A whole note, including non-reminder text');
	const sealed = await sealFile({ path, content, contentType: 'text/markdown' }, vault.forPath(path));
	expect((await openFile(sealed.bytes, path, pwa.forPath(path))).content).toEqual(content);
	expect(vault.forPath('Private/Secret.md')).toBe(vault.forVaultMetadata());
	for (const denied of ['', 'Reminders/../Private/Secret.md', '/Reminders/Inbox.md', 'Reminders\\Inbox.md', 'Reminders//Inbox.md', './Inbox.md']) {
		expect(() => pwa.forPath(denied)).toThrow();
	}
	const foreign = await FileKeyAuthority.fromBundle(await createVaultKeyBundle());
	await expect(openFile(sealed.bytes, path, foreign.forPath(path))).rejects.toThrow();
});
