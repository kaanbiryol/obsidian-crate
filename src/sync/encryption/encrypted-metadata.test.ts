import { expect, it, vi } from 'vitest';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { sealFile } from '../../encryption/file-codec';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { EncryptedFiles } from './encrypted-files';
import { PathTags } from '../../encryption/path-tags';
import type { WorkerApiHttpClient } from '../worker-api/http';

it('retries a repaired descriptor after authentication fails instead of caching the bad response', async () => {
  const keys = await createVaultKeyBundle(), path = 'note.md';
  const authority = await FileKeyAuthority.fromBundle(keys);
  const wire = await (await PathTags.fromSecret(keys.vaultId, keys.vault)).wire(path);
  const sealed = await sealFile({ path, content: new TextEncoder().encode('Private content'), contentType: 'text/markdown' }, authority.forPath(path));
  const requestJson = vi.fn().mockResolvedValueOnce({ descriptors: { revision: { ...sealed.descriptor, keyId: 'wrong-key' } } })
    .mockResolvedValue({ descriptors: { revision: sealed.descriptor } });
  const files = await EncryptedFiles.create({ requestJson } as unknown as WorkerApiHttpClient, keys, async () => null);
  const entry = { path: wire, entry: { hash: sealed.hash, size: sealed.bytes.length, revision: 'revision' } };
  await expect(files.metadata([entry])).rejects.toThrow('another vault or scope');
  expect(await files.metadata([entry])).toEqual([{ path, wire, entry: { ...entry.entry, hash: sealed.metadata.hash, size: sealed.metadata.size } }]);
  await files.metadata([entry]);
  expect(requestJson).toHaveBeenCalledTimes(2);
  // A verified revision cannot be presented under another server path.
  await expect(files.metadata([{ ...entry, path: await (await PathTags.fromSecret(keys.vaultId, keys.vault)).wire('other.md') }])).rejects.toThrow('requested file');
});
