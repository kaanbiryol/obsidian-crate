import { describe, expect, it } from 'vitest';
import { createVaultKeyBundle } from './key-bundle';
import { FileKeyAuthority } from './file-authority';
import { openFile, sealFile } from './file-codec';
import { encodeEncryptedFile, parseEncryptedFile } from './file-format';
import { sealFileForVault } from './sealed-file';
import { generateEphemeralP256 } from './p256';
import { PathTags } from './path-tags';
import { resolveEncryptedPath } from './path-binding';
import { importEncryptionSecret } from './envelope';
import { createOpaqueWireName } from '../protocol/encrypted-path';

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
    const keys = await FileKeyAuthority.fromBundle(bundle);
    const opened = await openFile(sealed.bytes, path, keys.forPath(path));
    expect(new TextDecoder().decode(opened.content)).toContain('Saved article');
  });

  it('opens only as Markdown at a server name inside the Reading folder, and never without the seal key', async () => {
    const { bundle, recipient } = await sealedNote();
    const tags = await PathTags.fromSecret(bundle.vaultId, bundle.vault), keys = await FileKeyAuthority.fromBundle(bundle);
    const reading = { plain: 'Reading', wire: await tags.wire('Reading') }, notes = await tags.wire('Notes');
    const note = (folder: string) => sealFileForVault({ path: `${folder}/Article.md`, content: content(), contentType: 'text/markdown' }, recipient);
    const bind = (wire: string) => (metadataPath: string, sealed: boolean) => resolveEncryptedPath(tags, wire, metadataPath, sealed, reading);
    const inside = `${reading.wire}/${createOpaqueWireName()}`, elsewhere = `${notes}/${createOpaqueWireName()}`;
    expect((await openFile((await note(reading.wire)).bytes, bind(inside), keys.forPath(inside))).metadata.path).toBe('Reading/Article.md');
    await expect(openFile((await note(notes)).bytes, bind(elsewhere), keys.forPath(elsewhere))).rejects.toThrow('does not match');
    const image = inside.replace(/\.md$/, '');
    await expect(openFile((await note(reading.wire)).bytes, bind(image), keys.forPath(image))).rejects.toThrow('created by the server');
    const withoutSeal = FileKeyAuthority.fromKey(bundle.vaultId, await importEncryptionSecret(bundle.vault));
    await expect(openFile((await note(reading.wire)).bytes, bind(inside), withoutSeal.forPath(inside))).rejects.toThrow('created by the server');
  });

  it('cannot be opened by another vault or with a tampered header', async () => {
    const { sealed } = await sealedNote();
    const other = await createVaultKeyBundle();
    await expect(openFile(sealed.bytes, path, (await FileKeyAuthority.fromBundle(other)).forPath(path))).rejects.toThrow();
    const { bundle, sealed: original } = await sealedNote();
    const keys = await FileKeyAuthority.fromBundle(bundle);
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
    const keys = await FileKeyAuthority.fromBundle(bundle);
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
