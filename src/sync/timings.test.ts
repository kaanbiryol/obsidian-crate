import { expect, it } from 'vitest';
import { normalizeSyncTimings, SyncTimingRecorder } from './timings';
it('measures phase transitions without resetting on progress-only updates', () => {
  let now = 100; const recorder = new SyncTimingRecorder(() => now);
  recorder.start(); now = 110; recorder.change({ phase: 'recovering', current: 0, total: 8 });
  now = 130; recorder.change({ phase: 'recovering', current: 4, total: 8 });
  now = 170; recorder.change({ phase: 'saving' }); now = 180; recorder.stop(); now = 500;
  expect(recorder.snapshot()).toEqual({ totalMs: 80, phases: { starting: 10, recovering: 60, saving: 10 } });
  recorder.start(); now = 510; recorder.stop();
  expect(recorder.snapshot()).toEqual({ totalMs: 10, phases: { starting: 10 } });
});
it('preserves only recognized finite timing fields', () => {
  expect(normalizeSyncTimings({ totalMs: 5, phases: { saving: 2, uploading: -1, recovering: Infinity, secret: 'no' }, arbitrary: 'no' }))
    .toEqual({ totalMs: 5, phases: { saving: 2 } });
  expect(normalizeSyncTimings({ totalMs: NaN, phases: {} })).toBeUndefined();
});

it('retains timings when settings history is normalized', async () => {
  const { normalizeCrateSettings } = await import('../plugin/settings');
  const timings = { totalMs: 40, phases: { saving: 40 } };
  const settings = normalizeCrateSettings({ syncHistory: [{ timestamp: '2026-09-14T00:00:00.000Z', type: 'sync', success: true, uploaded: 0, downloaded: 0, merged: 0, deleted: 0, errorCount: 0, conflictCount: 0, timings }] }, '.obsidian');
  expect(settings.syncHistory[0]?.timings).toEqual(timings);
});
