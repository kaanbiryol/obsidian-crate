import { expect, it, vi } from 'vitest';
import { SyncWorkerApi } from './sync';
import type { WorkerApiHttpClient } from './http';
import { computeHash } from '../hasher';
it('verifies retained bytes against the selected version and encodes its exact identity', async () => {
 const body = new TextEncoder().encode('saved').buffer;
 const version = { path: 'notes/a & b.md', storage_key: 'retained/key', hash: await computeHash(body), size: 5, reason: 'deleted' as const, created_at: '2026-09-19', expires_at: 1 };
 const requestBinary = vi.fn().mockResolvedValue({ body });
 const api = new SyncWorkerApi({ requestBinary } as unknown as WorkerApiHttpClient);
 expect(await api.previewFileVersion(version)).toEqual(body);
 const url = new URL(requestBinary.mock.calls[0]![0] as string, 'https://test');
 expect(url.searchParams.get('path')).toBe(version.path);
 expect(url.searchParams.get('storageKey')).toBe(version.storage_key);
 requestBinary.mockResolvedValue({ body: new TextEncoder().encode('wrong').buffer });
 await expect(api.previewFileVersion(version)).rejects.toThrow('integrity');
 await expect(api.previewFileVersion({ ...version, size: 99 })).rejects.toThrow('integrity');
});
