import { beforeEach, expect, it, vi } from 'vitest';
import { runMaintenanceEpisode } from './lifecycle';
import { runScheduledMaintenance } from '../maintenance';
vi.mock('../maintenance', () => ({ runScheduledMaintenance: vi.fn(async () => 0) }));
beforeEach(() => { vi.clearAllMocks(); });

function fixture(advancing: boolean) {
  let cursor = 0;
  const values = new Map<string, unknown>();
  const storage = { get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm: vi.fn() };
  const DB = { prepare: (sql: string) => ({ bind: () => ({ first: async () => null }), first: async () => sql.includes('orphan_sweep_cursor')
    ? { value: advancing ? String(cursor++) : 'unchanged' } : null }) };
  return { state: { storage } as never, env: { DB } as never, storage };
}
it('continues an advancing backlog but stops after ten passes', async () => {
  const { state, env, storage } = fixture(true);
  for (let pass = 0; pass < 12; pass++) await runMaintenanceEpisode(state, env);
  expect(runScheduledMaintenance).toHaveBeenCalledTimes(10);
  expect(storage.setAlarm).toHaveBeenCalledTimes(9);
});
it('does not retry a stuck backlog automatically', async () => {
  const { state, env, storage } = fixture(false);
  await runMaintenanceEpisode(state, env);
  expect(storage.setAlarm).not.toHaveBeenCalled();
});
