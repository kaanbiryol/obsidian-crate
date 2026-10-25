import { expect, it, vi } from 'vitest';
import type { VaultFile } from '../local/file-discovery';

const files: VaultFile[] = Array.from({ length: 200 }, (_, index) => ({ path: `notes/${index}.md`, size: 1, mtime: 1, extension: 'md' }));
vi.mock('../local/file-discovery', () => ({ getAllVaultFiles: vi.fn(async () => files) }));
vi.mock('../transfer/prepare', () => ({
  prepareUploadFromVaultFile: vi.fn(async (_transfer: unknown, file: VaultFile) => {
    events.push(`prepare ${file.path}`);
    return { path: file.path, content: new ArrayBuffer(1), size: 1, hash: `h-${file.path}` };
  }),
}));

import { ANOTHER_DEVICE_IMPORTING, runInitialImport } from './initial-import';
import { createEmptySyncResult } from '../sync-result';

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
    getImportToken: () => undefined, setImportToken: () => {},
  }, createEmptySyncResult());
  expect(result?.uploaded).toBe(200);
  // Before: no file was read while an upload was in flight.
  const start = events.indexOf('upload start');
  expect(events.slice(start, events.indexOf('upload end', start)).some(event => event.startsWith('prepare'))).toBe(true);
});

function importContext(token: string | undefined, revision: string | undefined) {
  const calls: string[] = [];
  const context = {
    transfer: {
      vault: {}, localManifest: { getEntry: () => revision ? { revision } : undefined, setEntry: vi.fn(), removeEntry: vi.fn() },
      runConcurrent: async (tasks: Array<() => Promise<void>>) => { for (const task of tasks) await task(); },
    } as never,
    api: {
      getManifest: async () => ({ files: { 'other.md': { hash: 'a'.repeat(64), size: 1, revision: 'r1', modified: new Date(1).toISOString() } } }),
      initialImport: {
        begin: async () => ({ state: 'importing', token: 't' }),
        prune: async () => { calls.push('prune'); },
        upload: async (_token: string, batch: Array<{ path: string; hash: string }>) => {
          calls.push('upload');
          return { results: batch.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'r' })) };
        },
        finish: async () => 1,
      },
    } as never,
    shouldIgnore: () => false, throwIfDestroyed: () => {}, setLastSeq: () => {}, report: () => {},
    save: async () => { calls.push('save'); },
    getImportToken: () => token,
    setImportToken: (value: string | undefined) => { calls.push(`token ${value}`); },
  };
  return { context, calls };
}

it('stops before pruning or uploading an import another device started', async () => {
  const { context, calls } = importContext(undefined, undefined);
  await expect(runInitialImport(context, createEmptySyncResult())).rejects.toThrow(ANOTHER_DEVICE_IMPORTING);
  expect(calls).toEqual([]);
});

it.each([['holds its token', 't', undefined], ['uploaded every server file', undefined, 'r1']] as const)('resumes an import when this device %s', async (_case, token, revision) => {
  const { context, calls } = importContext(token, revision);
  expect((await runInitialImport(context, createEmptySyncResult()))?.uploaded).toBe(200);
  expect(calls.slice(0, 3)).toEqual(token ? ['prune', 'upload', 'upload'] : ['token t', 'save', 'prune']);
  // Finishing releases the token.
  expect(calls.indexOf('token undefined')).toBeGreaterThan(calls.lastIndexOf('upload'));
});
