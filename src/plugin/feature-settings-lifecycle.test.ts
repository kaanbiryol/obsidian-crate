import { beforeEach, expect, it, vi } from 'vitest';
import CratePlugin from './CratePlugin';
import { refreshSharedFeatures, setSharedFeature } from './feature-settings';
import { serverRequest } from './server-request';
import { normalizeCrateSettings } from './settings';
import { DEFAULT_REMINDERS_SETTINGS, useRemindersSettingsStore } from '../reminders/settings';
import { startReading, stopReading } from '../reading/runtime';
import { endPluginLifecycle } from './lifecycle-state';
import { initializeReminders } from '../reminders/plugin-integration';

vi.mock('./lifecycle', () => ({ bootstrapPlugin: vi.fn(), shutdownPlugin: vi.fn() }));
vi.mock('./server-request', async importOriginal => ({ ...await importOriginal<typeof import('./server-request')>(), serverRequest: vi.fn() }));
vi.mock('../reading/runtime', () => ({ startReading: vi.fn(), stopReading: vi.fn() }));
vi.mock('../reminders/plugin-integration', () => ({ initializeReminders: vi.fn(), reinitializeReminders: vi.fn() }));
vi.mock('../reminders/ui/workspaceLayout', () => ({ activateOrRevealRemindersLeaf: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  useRemindersSettingsStore.setState({ ...DEFAULT_REMINDERS_SETTINGS, enabled: true }, true);
});

function fixture() {
  const plugin = new CratePlugin({} as never, {} as never);
  let token = 'original';
  const saveData = vi.fn<(value: unknown) => Promise<void>>(async () => {});
  const refresh = vi.fn();
  const detachLeaves = vi.fn();
  Object.assign(plugin, {
    app: { vault: { configDir: '.obsidian' }, workspace: { detachLeavesOfType: detachLeaves } },
    settings: normalizeCrateSettings({ workerUrl: 'https://original.example', reading: { enabled: true, folderPath: 'Reading' } }, '.obsidian'),
    secretStorage: { get: () => token }, saveData, refreshSettingsTab: refresh,
  });
  return { plugin, saveData, refresh, detachLeaves, changeToken: () => { token = 'replacement'; } };
}

it.each(['server', 'token'] as const)('does not send a shared policy mutation when the %s changes after its read', async kind => {
  const f = fixture();
  vi.mocked(serverRequest).mockImplementationOnce(async () => {
    if (kind === 'server') f.plugin.settings.workerUrl = 'https://replacement.example'; else f.changeToken();
    return { reading: true, reminders: true, revision: 'original' };
  });
  await expect(setSharedFeature(f.plugin, 'reading', false)).rejects.toMatchObject({ name: 'AbortError' });
  expect(serverRequest).toHaveBeenCalledOnce();
  expect(f.saveData).not.toHaveBeenCalled();
  expect(stopReading).not.toHaveBeenCalled();
});

it('keeps queued feature intent bound to the connection on which it was requested', async () => {
  const f = fixture();
  let release!: (value: unknown) => void;
  vi.mocked(serverRequest).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = refreshSharedFeatures(f.plugin);
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(serverRequest).toHaveBeenCalledOnce());
  const queued = setSharedFeature(f.plugin, 'reading', false);
  const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  f.changeToken();
  release({ reading: true, reminders: true, revision: 'original' });
  await Promise.all([firstRejected, queuedRejected]);
  expect(serverRequest).toHaveBeenCalledOnce();
});

it.each(['reading', 'reminders'] as const)('does not dispatch a queued %s settings save after a connection change', async feature => {
  const f = fixture();
  let release!: () => void;
  f.saveData.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const active = f.plugin.writeSettings({ syncInterval: 60 });
  await vi.waitFor(() => expect(f.saveData).toHaveBeenCalledOnce());
  vi.mocked(serverRequest).mockResolvedValue({ reading: feature !== 'reading', reminders: feature !== 'reminders', revision: 'original' });
  const write = vi.spyOn(f.plugin, feature === 'reading' ? 'writeSettings' : 'writeRemindersSettings');
  const pending = refreshSharedFeatures(f.plugin, false);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(write).toHaveBeenCalled());
  f.changeToken();
  release();
  await active;
  await rejected;
  expect(f.saveData).toHaveBeenCalledOnce();
  expect(f.plugin.settings.reading.enabled).toBe(true);
  expect(f.plugin.remindersSettings.enabled).toBe(true);
  expect(f.refresh).not.toHaveBeenCalled();
});

it.each(['reading', 'reminders'] as const)('does not publish an in-flight %s save or activate stale backends after a server switch', async feature => {
  const f = fixture();
  let release!: () => void;
  f.saveData.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  vi.mocked(serverRequest).mockResolvedValue({ reading: feature !== 'reading', reminders: feature !== 'reminders', revision: 'original' });
  const pending = refreshSharedFeatures(f.plugin);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(f.saveData).toHaveBeenCalledOnce());
  // Infrastructure transitions change the live connection before persisting it.
  f.plugin.settings.workerUrl = 'https://replacement.example';
  const switched = f.plugin.writeSettings({ workerUrl: 'https://replacement.example' });
  release();
  await rejected;
  await switched;
  expect(f.plugin.settings.workerUrl).toBe('https://replacement.example');
  expect(f.plugin.settings.reading.enabled).toBe(true);
  expect(f.plugin.remindersSettings.enabled).toBe(true);
  expect(f.saveData.mock.lastCall?.[0]).toMatchObject({ workerUrl: 'https://replacement.example', reading: { enabled: true }, reminders: { enabled: true } });
  expect(stopReading).not.toHaveBeenCalled();
  expect(startReading).not.toHaveBeenCalled();
  expect(initializeReminders).not.toHaveBeenCalled();
  expect(f.detachLeaves).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
});

it('returns a rejected promise for feature requests after unload', async () => {
  const f = fixture();
  endPluginLifecycle(f.plugin);
  await expect(setSharedFeature(f.plugin, 'reading', false)).rejects.toMatchObject({ name: 'AbortError' });
  expect(serverRequest).not.toHaveBeenCalled();
});

it('does not roll back the new connection when old reminder initialization fails late', async () => {
  const f = fixture();
  useRemindersSettingsStore.setState({ enabled: false });
  let fail!: (error: Error) => void;
  vi.mocked(initializeReminders).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  vi.mocked(serverRequest).mockResolvedValue({ reading: true, reminders: true, revision: 'original' });
  const pending = refreshSharedFeatures(f.plugin);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(initializeReminders).toHaveBeenCalledOnce());
  f.changeToken();
  fail(new Error('Old initialization failed'));
  await rejected;
  expect(f.saveData).toHaveBeenCalledOnce();
  expect(f.plugin.remindersSettings.enabled).toBe(true);
  expect(f.refresh).not.toHaveBeenCalled();
});

it('keeps local feature toggles available without a server connection', async () => {
  const f = fixture();
  f.plugin.settings.workerUrl = '';
  await setSharedFeature(f.plugin, 'reading', false);
  expect(f.plugin.settings.reading.enabled).toBe(false);
  expect(serverRequest).not.toHaveBeenCalled();
  expect(stopReading).toHaveBeenCalledOnce();
});
