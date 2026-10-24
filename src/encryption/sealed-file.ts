import { sealFileWithHeader } from './file-codec';
import { deriveP256Secret, generateEphemeralP256 } from './p256';
import { sealedFileKey } from './sealed-file-key';

/** The public half of the vault seal key, as published in the server's state. */
export interface SealRecipient { vaultId: string; keyId: string; publicKey: string }

/** Lets a party holding only the public key create a file that unlocked clients can
 * open. It cannot read the file back. Sealed files never carry scheduling data. */
export async function sealFileForVault(input: { path: string; content: Uint8Array<ArrayBuffer>; contentType: string }, recipient: SealRecipient) {
  const objectId = crypto.randomUUID();
  const ephemeral = await generateEphemeralP256();
  const key = await sealedFileKey(await deriveP256Secret(ephemeral.privateKey, recipient.publicKey),
    { vaultId: recipient.vaultId, objectId, keyId: recipient.keyId, epk: ephemeral.publicKey, recipient: recipient.publicKey });
  return sealFileWithHeader({ ...input, publicData: null },
    { version: 1, vaultId: recipient.vaultId, scopeId: 'vault', objectId, keyId: recipient.keyId, seal: { epk: ephemeral.publicKey } }, key);
}
