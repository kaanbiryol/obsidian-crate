import { createECDH } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from './encoding';
import { decryptJson, encryptJson, importEncryptionSecret } from './envelope';
import { FileKeyAuthority } from './file-authority';
import { openFile, sealFile } from './file-codec';
import { openFolderLabel, sealFolderLabel } from './folder-label';
import { openRecoveryBundle, sameVaultKeyBundle, sealRecoveryBundle, validateVaultKeyBundle, type RecoveryEnvelope, type VaultKeyBundle } from './key-bundle';
import { LocalStateCipher } from './local-state';
import { pairingCommitment, type PairingContext } from './pairing/protocol';
import { PathTags } from './path-tags';
import { createReminderProjection, importNotificationKeys, openNotification } from './reminder-projection';
import { sealFileForVault } from './sealed-file';
import type { EncryptedSchedules } from './notification-format';

/**
 * Frozen samples of every encrypted format that released clients have written.
 * Round-trip tests only prove that today's code reads what today's code writes;
 * these prove it still reads what earlier releases wrote.
 *
 * Fixtures are append-only. Never edit or regenerate an existing entry: a failure
 * here means stored user data or a released client would break. To freeze a new
 * format version, add an entry to `fixtures` below, then run
 * `CRATE_WRITE_ENCRYPTION_FIXTURES=1 npx vitest run src/encryption/format-fixtures.test.ts`,
 * which writes only the entries that are missing.
 */

const FIXTURE_FILE = new URL('./__fixtures__/encrypted-formats.json', import.meta.url);
const WRITE = process.env.CRATE_WRITE_ENCRYPTION_FIXTURES === '1';

// Synthetic keys derived from fixed byte runs, so no secret strings are committed.
const run = (start: number) => Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 255);
function sealPair() {
	const ecdh = createECDH('prime256v1');
	ecdh.setPrivateKey(Buffer.from(run(1)));
	return { id: 'fixture-seal-key', publicKey: encodeBase64Url(ecdh.getPublicKey()), privateKey: encodeBase64Url(run(1)) };
}
const bundle: VaultKeyBundle = {
	version: 1, vaultId: 'fixture-vault', generation: 1,
	vault: { id: 'fixture-vault-key', secret: encodeBase64Url(run(0x40)) },
	notifications: { id: 'fixture-notification-key', secret: encodeBase64Url(run(0x60)) },
	seal: sealPair(),
};
validateVaultKeyBundle(bundle);
const recoveryCode = async () => {
	const bytes = run(0xa0);
	const checksum = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 6));
	return `crate-recovery-v1.${encodeBase64Url(bytes)}.${checksum}`;
};
const text = (value: string) => new TextEncoder().encode(value);
const vaultKey = () => importEncryptionSecret(bundle.vault);

interface Fixture<T> { generate(): Promise<T>; verify(value: T): Promise<void> }
const fixture = <T>(value: Fixture<T>) => value as Fixture<unknown>;

const envelopeContext = { vaultId: bundle.vaultId, scopeId: 'vault', objectId: 'shared-settings', purpose: 'settings' as const };
const envelopeValue = { theme: 'dark', folders: ['Reminders', 'Reading'], note: 'Ünïcødé ✓' };
const vaultFileInput = { path: 'Reminders/Personal.md', contentType: 'text/markdown', content: '- [ ] Dentist 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->\n', publicData: { version: 1, reminders: [] } };
const sealedFileInput = { path: 'Reading/Saved article.md', contentType: 'text/markdown', content: '# Saved article\n\nSynthetic reading note.\n' };
const tagPaths = ['Note.md', 'folder/Note.md', 'Folder/NOTE.md', 'Reminders/Personal.md', 'a/b/c/attachment.png', 'Café/Ünïcødé.md'];
const localState = { vaultId: bundle.vaultId, scopeId: 'vault', storageKey: 'crate-outbox', value: '{"pending":[{"id":"op-1"}]}' };
const pairingContext: PairingContext = { version: 1, id: 'fixture-pairing', origin: 'https://crate.example.test', vaultId: bundle.vaultId, generation: 1 };
const reminderMarkdown = '- [ ] Dentist 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->\n- [x] Groceries 2099-01-01 <!-- crate-id:r2 -->\n';
const withoutEnvelopes = (value: EncryptedSchedules) => ({ ...value, reminders: value.reminders.map(item => ({ ...item, notification: { ...item.notification, envelope: '' } })) });

const fixtures: Record<string, Fixture<unknown>> = {
	'envelope-v1-json': fixture<{ envelope: string }>({
		generate: async () => ({ envelope: await encryptJson(envelopeValue, await vaultKey(), envelopeContext) }),
		verify: async ({ envelope }) => expect(await decryptJson(envelope, await vaultKey(), envelopeContext)).toEqual(envelopeValue),
	}),
	'file-v1-vault-key': fixture<{ bytes: string }>({
		generate: async () => {
			const authority = (await FileKeyAuthority.fromBundle(bundle)).forPath(vaultFileInput.path);
			return { bytes: new TextDecoder().decode((await sealFile({ ...vaultFileInput, content: text(vaultFileInput.content) }, authority)).bytes) };
		},
		verify: async ({ bytes }) => {
			const authority = (await FileKeyAuthority.fromBundle(bundle)).forPath(vaultFileInput.path);
			const opened = await openFile(text(bytes), vaultFileInput.path, authority);
			expect(new TextDecoder().decode(opened.content)).toBe(vaultFileInput.content);
			expect(opened.publicData).toEqual(vaultFileInput.publicData);
			expect(opened.metadata).toMatchObject({ version: 1, path: vaultFileInput.path, contentType: vaultFileInput.contentType });
		},
	}),
	'file-v1-sealed-to-vault': fixture<{ bytes: string }>({
		generate: async () => {
			const sealed = await sealFileForVault({ ...sealedFileInput, content: text(sealedFileInput.content) },
				{ vaultId: bundle.vaultId, keyId: bundle.seal.id, publicKey: bundle.seal.publicKey });
			return { bytes: new TextDecoder().decode(sealed.bytes) };
		},
		verify: async ({ bytes }) => {
			const authority = (await FileKeyAuthority.fromBundle(bundle)).forPath(sealedFileInput.path);
			const opened = await openFile(text(bytes), sealedFileInput.path, authority);
			expect(new TextDecoder().decode(opened.content)).toBe(sealedFileInput.content);
			expect(opened.publicData).toBeNull();
		},
	}),
	'recovery-v1': fixture<{ code: string; envelope: RecoveryEnvelope }>({
		generate: async () => ({ code: await recoveryCode(), envelope: await sealRecoveryBundle(bundle, await recoveryCode()) }),
		verify: async ({ code, envelope }) => {
			expect(code).toBe(await recoveryCode());
			expect(sameVaultKeyBundle(await openRecoveryBundle(envelope, code), bundle)).toBe(true);
		},
	}),
	// Path tags are deterministic and are the server identity of every encrypted
	// file, so new writes must keep producing exactly these values.
	'path-tags-v1': fixture<{ wire: Record<string, string> }>({
		generate: async () => {
			const tags = await PathTags.fromSecret(bundle.vaultId, bundle.vault);
			return { wire: Object.fromEntries(await Promise.all(tagPaths.map(async path => [path, await tags.wire(path)]))) as Record<string, string> };
		},
		verify: async ({ wire }) => {
			const tags = await PathTags.fromSecret(bundle.vaultId, bundle.vault);
			for (const [path, expected] of Object.entries(wire)) expect(await tags.wire(path), path).toBe(expected);
		},
	}),
	'folder-label-v1': fixture<{ wire: string; label: string }>({
		generate: async () => sealFolderLabel('Reminders', await PathTags.fromSecret(bundle.vaultId, bundle.vault), await vaultKey(), bundle.vaultId),
		verify: async ({ wire, label }) => {
			expect(await openFolderLabel(wire, label, await PathTags.fromSecret(bundle.vaultId, bundle.vault), await vaultKey(), bundle.vaultId)).toBe('Reminders');
		},
	}),
	'local-state-v1': fixture<{ sealed: string }>({
		generate: async () => ({ sealed: new LocalStateCipher(localState.vaultId, localState.scopeId, run(0x80)).seal(localState.value, localState.storageKey) }),
		verify: async ({ sealed }) => {
			expect(new LocalStateCipher(localState.vaultId, localState.scopeId, run(0x80)).open(sealed, localState.storageKey)).toBe(localState.value);
		},
	}),
	// Fingerprints are deterministic; envelopes are random, so they are only opened.
	'reminder-projection-v1': fixture<{ projection: EncryptedSchedules }>({
		generate: async () => {
			const keys = await importNotificationKeys(bundle.vaultId, bundle.notifications);
			return { projection: (await createReminderProjection(keys, ['Reminders'], 'Reminders/Personal.md', text(reminderMarkdown).buffer))! };
		},
		verify: async ({ projection }) => {
			const keys = await importNotificationKeys(bundle.vaultId, bundle.notifications);
			const current = await createReminderProjection(keys, ['Reminders'], 'Reminders/Personal.md', text(reminderMarkdown).buffer);
			expect(withoutEnvelopes(current!)).toEqual(withoutEnvelopes(projection));
			const titles = await Promise.all(projection.reminders.map(item => openNotification(item.notification, keys.key, bundle.vaultId)));
			expect(titles).toEqual([{ title: 'Dentist', body: 'Personal' }, { title: 'Groceries', body: 'Personal' }]);
		},
	}),
	'pairing-commitment-v1': fixture<{ commitment: string }>({
		generate: async () => ({ commitment: await pairingCommitment(pairingContext, bundle.seal.publicKey) }),
		verify: async ({ commitment }) => expect(await pairingCommitment(pairingContext, bundle.seal.publicKey)).toBe(commitment),
	}),
};

const stored = existsSync(FIXTURE_FILE) ? JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Record<string, unknown> : {};

describe('frozen encrypted formats', () => {
	if (WRITE) {
		it('writes missing fixtures without touching existing ones', async () => {
			for (const [name, entry] of Object.entries(fixtures)) stored[name] ??= await entry.generate();
			writeFileSync(FIXTURE_FILE, JSON.stringify(stored, null, '\t') + '\n');
		});
		return;
	}
	it('has a stored sample for every format and keeps retired ones', () => {
		expect(Object.keys(stored).sort()).toEqual(Object.keys(fixtures).sort());
	});
	for (const [name, entry] of Object.entries(fixtures)) {
		it(`still opens ${name}`, async () => {
			expect(stored[name], `Missing fixture ${name}; see the comment at the top of this file`).toBeDefined();
			await entry.verify(stored[name]);
		});
	}
});
