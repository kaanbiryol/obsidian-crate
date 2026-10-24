import { describe, expect, it } from 'vitest';
import { createVaultKeyBundle } from './key-bundle';
import { FileKeyAuthority } from './file-authority';
import { openFile, sealFile } from './file-codec';
import { encodeEncryptedFile, parseEncryptedFile } from './file-format';
import { sealFileForVault } from './sealed-file';
import { generateEphemeralP256 } from './p256';

const path = 'Reading/Article - 1234abcd.md';
const content = () => new TextEncoder().encode('---\ncrate_reading_id: x\n---\nSaved article');

async function sealedNote(note = path) {
  const bundle = await createVaultKeyBundle();
  const recipient = { vaultId: bundle.vaultId, keyId: bundle.seal.id, publicKey: bundle.seal.publicKey };
  return { bundle, recipient, sealed: await sealFileForVault({ path: note, content: content(), contentType: 'text/markdown' }, recipient) };
}

describe('sealFileForVault', () => {
  it('creates a note that the vault opens inside the Reading folder', async () => {
    const { bundle, sealed } = await sealedNote();
    expect(sealed.descriptor).toMatchObject({ vaultId: bundle.vaultId, scopeId: 'vault', keyId: bundle.seal.id });
    expect(typeof sealed.descriptor.seal?.epk).toBe('string');
    expect(parseEncryptedFile(sealed.bytes).publicData).toBeNull();
    const keys = await FileKeyAuthority.fromBundle(bundle, () => 'Reading');
    const opened = await openFile(sealed.bytes, path, keys.forPath(path));
    expect(new TextDecoder().decode(opened.content)).toContain('Saved article');
  });

  it('is refused outside the Reading folder, for other file types and without a Reading folder', async () => {
    const elsewhere = await sealedNote('Notes/Article.md');
    await expect(openFile(elsewhere.sealed.bytes, 'Notes/Article.md', (await FileKeyAuthority.fromBundle(elsewhere.bundle, () => 'Reading')).forPath('Notes/Article.md'))).rejects.toThrow('created by the server');
    const attachment = await sealedNote('Reading/image.png');
    await expect(openFile(attachment.sealed.bytes, 'Reading/image.png', (await FileKeyAuthority.fromBundle(attachment.bundle, () => 'Reading')).forPath('Reading/image.png'))).rejects.toThrow('created by the server');
    const { bundle, sealed } = await sealedNote();
    await expect(openFile(sealed.bytes, path, (await FileKeyAuthority.fromBundle(bundle)).forPath(path))).rejects.toThrow('created by the server');
  });

  it('cannot be opened by another vault or with a tampered header', async () => {
    const { sealed } = await sealedNote();
    const other = await createVaultKeyBundle();
    await expect(openFile(sealed.bytes, path, (await FileKeyAuthority.fromBundle(other, () => 'Reading')).forPath(path))).rejects.toThrow();
    const { bundle, sealed: original } = await sealedNote();
    const keys = await FileKeyAuthority.fromBundle(bundle, () => 'Reading');
    const packet = parseEncryptedFile(original.bytes);
    const tampered = [
      { ...packet.descriptor, seal: { epk: (await generateEphemeralP256()).publicKey } },
      { ...packet.descriptor, objectId: crypto.randomUUID() },
    ];
    for (const descriptor of tampered) {
      await expect(openFile(encodeEncryptedFile({ ...packet, descriptor }), path, keys.forPath(path))).rejects.toThrow();
    }
  });

  it('keeps sealed and vault-key files apart, and edits re-save with the vault key', async () => {
    const { bundle, sealed } = await sealedNote();
    const keys = await FileKeyAuthority.fromBundle(bundle, () => 'Reading');
    const packet = parseEncryptedFile(sealed.bytes);
    // A sealed descriptor that names the vault key is not opened with the vault key.
    const { seal: _seal, ...unsealed } = packet.descriptor;
    await expect(openFile(encodeEncryptedFile({ ...packet, descriptor: { ...unsealed, keyId: bundle.vault.id } }), path, keys.forPath(path))).rejects.toThrow();
    const edited = await sealFile({ path, content: content(), contentType: 'text/markdown' }, keys.forPath(path));
    expect(edited.descriptor.keyId).toBe(bundle.vault.id);
    expect(edited.descriptor.seal).toBeUndefined();
    await expect(openFile(edited.bytes, path, keys.forPath(path))).resolves.toBeDefined();
  });
});
