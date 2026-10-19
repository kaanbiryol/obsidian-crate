import { expect, it, vi } from 'vitest';
import type { VaultFile } from './file-discovery';

const files: VaultFile[] = Array.from({ length: 200 }, (_, index) => ({ path: `notes/${index}.md`, size: 1, mtime: 1, extension: 'md' }));
vi.mock('./file-discovery', () => ({ getAllVaultFiles: vi.fn(async () => files) }));
vi.mock('./transfer/prepare', () => ({
  prepareUploadFromVaultFile: vi.fn(async (_transfer: unknown, file: VaultFile) => {
    events.push(`prepare ${file.path}`);
    return { path: file.path, content: new ArrayBuffer(1), size: 1, hash: `h-${file.path}` };
  }),
}));

import { runInitialImport } from './initial-import';
import { createEmptySyncResult } from './sync-result';

const events: string[] = [];

it('prepares the next chunk of an initial import while the current one uploads', async () => {
  const upload = vi.fn(async (_token: string, batch: Array<{ path: string; hash: string }>) => {
    events.push('upload start');
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push('upload end');
    return { results: batch.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'r' })) };
  });
  const result = await runInitialImport({
    transfer: {
      vault: {}, localManifest: { setEntry: vi.fn(), removeEntry: vi.fn() },
      runConcurrent: async (tasks: Array<() => Promise<void>>) => { for (const task of tasks) await task(); },
    } as never,
    api: {
      getManifest: async () => ({ files: {} }),
      initialImport: { begin: async () => ({ state: 'importing', token: 't' }), prune: async () => {}, upload, finish: async () => 1 },
    } as never,
    shouldIgnore: () => false, throwIfDestroyed: () => {}, save: async () => {}, setLastSeq: () => {}, report: () => {},
  }, createEmptySyncResult());
  expect(result?.uploaded).toBe(200);
  // Before: no file was read while an upload was in flight.
  const start = events.indexOf('upload start');
  expect(events.slice(start, events.indexOf('upload end', start)).some(event => event.startsWith('prepare'))).toBe(true);
});
