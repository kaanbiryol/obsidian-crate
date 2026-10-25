import type CratePlugin from './CratePlugin';
import type { SyncState } from '../sync/types';
import { captureServerConnection, serverRequest } from './server-request';
import { restartReading } from '../reading/runtime';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { parseFeaturePolicy, type FeaturePolicy } from '../protocol/feature-policy';
import { sharedSettingsSync } from './shared-settings-sync';

async function requestFeatures(plugin: CratePlugin, body?: unknown): Promise<FeaturePolicy> {
  const policy = parseFeaturePolicy(await serverRequest<unknown>(plugin, '/features', body, { timeout: 5_000 }));
  if (!policy) throw new Error('Could not read shared feature settings.');
  return policy;
}
const tasks = new WeakMap<CratePlugin, Promise<void>>();
async function apply(plugin: CratePlugin, policy: FeaturePolicy, activate: boolean, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  if (plugin.settings.reading.enabled !== policy.reading) {
    await plugin.writeSettings({ reading: { ...plugin.settings.reading, enabled: policy.reading } }, assertCurrent);
    assertCurrent();
    restartReading(plugin, activate && policy.reading);
  }
  if (plugin.remindersSettings.enabled !== policy.reminders) {
    if (activate) {
      // Loaded on demand so settings screens do not load the reminders UI.
      const { setRemindersEnabled } = await import('../reminders/plugin-integration');
      await setRemindersEnabled(plugin, policy.reminders, assertCurrent);
    } else await plugin.writeRemindersSettings({ enabled: policy.reminders }, assertCurrent);
  }
  assertCurrent();
}
async function serialize(plugin: CratePlugin, action: (assertCurrent: () => void) => Promise<void>): Promise<void> {
  const { assertCurrent } = captureServerConnection(plugin);
  const next = (tasks.get(plugin) ?? Promise.resolve()).catch(() => {}).then(() => {
    assertCurrent();
    return action(assertCurrent);
  });
  tasks.set(plugin, next);
  return next;
}
export function refreshSharedFeatures(plugin: CratePlugin, activate = true): Promise<void> {
  return serialize(plugin, async assertCurrent => {
    if (!plugin.settings.workerUrl || getPluginLifecycleSignal(plugin).aborted) return;
    const policy = await requestFeatures(plugin);
    const changed = policy.reading !== plugin.settings.reading.enabled || policy.reminders !== plugin.remindersSettings.enabled;
    await apply(plugin, policy, activate, assertCurrent);
    assertCurrent();
    if (changed && activate) plugin.refreshSettingsTab();
  });
}
export function setSharedFeature(plugin: CratePlugin, feature: 'reading' | 'reminders', enabled: boolean): Promise<void> {
  return serialize(plugin, async assertCurrent => {
    if (!plugin.settings.workerUrl) {
      await apply(plugin, { reading: plugin.settings.reading.enabled, reminders: plugin.remindersSettings.enabled, revision: null, [feature]: enabled }, true, assertCurrent);
      return;
    }
    const current = await requestFeatures(plugin);
    assertCurrent();
    const policy = await requestFeatures(plugin, { feature, enabled, revision: current.revision });
    await apply(plugin, policy, true, assertCurrent);
  });
}
/** Automatic syncs can run every few seconds; the policy rarely changes. */
export const SHARED_FEATURES_REFRESH_INTERVAL_MS = 10 * 60_000;
export function registerSharedFeatures(plugin: CratePlugin): void {
  let refreshing = false;
  let lastRefreshAt: number | null = null;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    // Shared sync settings ride the same throttled refresh as the feature policy.
    void sharedSettingsSync(plugin).pull();
    void refreshSharedFeatures(plugin).then(() => { lastRefreshAt = Date.now(); })
      .catch(() => { /* Keep the last confirmed state offline. */ }).finally(() => { refreshing = false; });
  };
  // Changes from other devices arrive with sync; the server enforces them meanwhile.
  let wasSyncing = false;
  const listener = (state: SyncState) => {
    if (wasSyncing && state.status === 'idle'
      && (lastRefreshAt === null || Date.now() - lastRefreshAt >= SHARED_FEATURES_REFRESH_INTERVAL_MS)) refresh();
    wasSyncing = state.status === 'syncing';
  };
  plugin.syncRuntime.addStateChangeListener(listener);
  plugin.register(() => plugin.syncRuntime.removeStateChangeListener(listener));
  refresh();
}
