import { beforeEach, expect, it, vi } from 'vitest';
import type CratePlugin from './CratePlugin';
import { refreshSharedFeatures, setSharedFeature } from './feature-settings';
import { startReading, stopReading } from '../reading/runtime';
import { readingServerRequest } from '../reading/server';
vi.mock('../reading/server', () => ({ readingServerRequest: vi.fn() }));
vi.mock('../reading/runtime', () => ({ startReading: vi.fn(), stopReading: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const plugin = {
    settings: { workerUrl: 'https://crate.example', reading: { enabled: true, folderPath: 'Reading' } },
    remindersSettings: { enabled: true },
    app: { workspace: { detachLeavesOfType: vi.fn() } }, refreshSettingsTab: vi.fn(),
    writeSettings: vi.fn(async (value: { reading: { enabled: boolean; folderPath: string } }) => { plugin.settings.reading = value.reading; }),
    setRemindersEnabled: vi.fn(async (enabled: boolean) => { plugin.remindersSettings.enabled = enabled; }),
    writeRemindersSettings: vi.fn(async (value: { enabled: boolean }) => { plugin.remindersSettings = value; }),
  };
  return plugin;
}
it('changes the shared policy before applying local state and keeps other feature settings', async () => {
  const plugin = fixture();
  vi.mocked(readingServerRequest).mockResolvedValueOnce({ reading: true, reminders: true, revision: 'one' })
    .mockResolvedValueOnce({ reading: false, reminders: true, revision: 'two' });
  await setSharedFeature(plugin as unknown as CratePlugin, 'reading', false);
  expect(readingServerRequest).toHaveBeenLastCalledWith(plugin, '/features', { feature: 'reading', enabled: false, revision: 'one' });
  expect(plugin.settings.reading.enabled).toBe(false);
  expect(stopReading).toHaveBeenCalledOnce();
  expect(plugin.setRemindersEnabled).not.toHaveBeenCalled();
});
it('does not pretend to change the shared feature when the server rejects it', async () => {
  const plugin = fixture();
  vi.mocked(readingServerRequest).mockResolvedValueOnce({ reading: true, reminders: true, revision: 'one' }).mockRejectedValueOnce(new Error('Offline'));
  await expect(setSharedFeature(plugin as unknown as CratePlugin, 'reading', false)).rejects.toThrow('Offline');
  expect(plugin.writeSettings).not.toHaveBeenCalled();
});
it('pulls paused state before initialization without writing stale local flags back', async () => {
  const plugin = fixture();
  vi.mocked(readingServerRequest).mockResolvedValue({ reading: false, reminders: false, revision: 'one' });
  await refreshSharedFeatures(plugin as unknown as CratePlugin, false);
  expect(plugin.settings.reading.enabled).toBe(false);
  expect(plugin.remindersSettings.enabled).toBe(false);
  expect(readingServerRequest).toHaveBeenCalledExactlyOnceWith(plugin, '/features');
  expect(plugin.setRemindersEnabled).not.toHaveBeenCalled();
  expect(startReading).not.toHaveBeenCalled();
});
it('resumes local backends when another device resumes the server features', async () => {
  const plugin = fixture(); plugin.settings.reading.enabled = false; plugin.remindersSettings.enabled = false;
  vi.mocked(readingServerRequest).mockResolvedValue({ reading: true, reminders: true, revision: 'one' });
  await refreshSharedFeatures(plugin as unknown as CratePlugin);
  expect(startReading).toHaveBeenCalledOnce();
  expect(plugin.setRemindersEnabled).toHaveBeenCalledWith(true);
  expect(plugin.refreshSettingsTab).toHaveBeenCalledOnce();
});
