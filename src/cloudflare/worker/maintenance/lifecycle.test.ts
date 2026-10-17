import { beforeEach, expect, it, vi } from 'vitest';
import { runMaintenanceEpisode } from './lifecycle';
import { runScheduledMaintenance } from '../maintenance';
vi.mock('../maintenance', () => ({ runScheduledMaintenance: vi.fn(async () => ({ removedObjects: 0, backlog: false })) }));
beforeEach(() => { vi.clearAllMocks(); });

function fixture(advancing: 'queue' | 'staged' | null) {
  let cursor = 0;
  const values = new Map<string, unknown>();
  const storage = { get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm: vi.fn() };
  const DB = { prepare: (sql: string) => ({ bind: () => ({ first: async () => null }), first: async () => {
    if (sql.includes('object_cleanup_queue')) return { storage_key: advancing === 'queue' ? String(cursor++) : 'unchanged' };
    return sql.includes('staged_uploads') && advancing === 'staged' ? { storage_key: String(cursor++), expires_at: 0 } : null;
  } }) };
  return { state: { storage } as never, env: { DB } as never, storage };
}
it('continues other advancing backlogs but stops after ten passes', async () => {
  const { state, env, storage } = fixture('staged');
  for (let pass = 0; pass < 12; pass++) await runMaintenanceEpisode(state, env);
  expect(runScheduledMaintenance).toHaveBeenCalledTimes(10);
  expect(storage.setAlarm).toHaveBeenCalledTimes(9);
});
it('keeps draining an advancing object cleanup queue up to 200 passes', async () => {
  const { state, env, storage } = fixture('queue');
  for (let pass = 0; pass < 202; pass++) await runMaintenanceEpisode(state, env);
  expect(runScheduledMaintenance).toHaveBeenCalledTimes(200);
  expect(storage.setAlarm).toHaveBeenCalledTimes(199);
});
it('does not retry a stuck backlog automatically', async () => {
  const { state, env, storage } = fixture(null);
  await runMaintenanceEpisode(state, env);
  expect(storage.setAlarm).not.toHaveBeenCalled();
});
it('continues a pruning backlog within the ten-pass episode budget', async () => {
  vi.mocked(runScheduledMaintenance).mockResolvedValue({ removedObjects: 0, backlog: true });
  const { state, env, storage } = fixture(null);
  for (let pass = 0; pass < 12; pass++) await runMaintenanceEpisode(state, env);
  expect(runScheduledMaintenance).toHaveBeenCalledTimes(10);
  expect(storage.setAlarm).toHaveBeenCalledTimes(9);
});
