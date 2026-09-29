import type CratePlugin from './CratePlugin';
import { captureServerConnection, serverRequest } from './server-request';
import { startReading, stopReading } from '../reading/runtime';
import { getPluginLifecycleSignal } from './lifecycle-state';

interface Features { reading: boolean; reminders: boolean; revision: string | null }
function requestFeatures(plugin: CratePlugin, body?: unknown): Promise<Features> {
  return serverRequest(plugin, '/features', body, {
    timeout: 5_000,
    capabilities: { 'shared-features-v1': 'Update your Crate server to share feature settings.' },
  });
}
const tasks = new WeakMap<CratePlugin, Promise<void>>();
async function apply(plugin: CratePlugin, policy: Features, activate: boolean, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  if (typeof policy.reading !== 'boolean' || typeof policy.reminders !== 'boolean') throw new Error('Could not read shared feature settings.');
  if (plugin.settings.reading.enabled !== policy.reading) {
    await plugin.writeSettings({ reading: { ...plugin.settings.reading, enabled: policy.reading } }, assertCurrent);
    assertCurrent();
    stopReading(plugin);
    plugin.app.workspace.detachLeavesOfType('crate-reading');
    if (activate && policy.reading) startReading(plugin);
  }
  if (plugin.remindersSettings.enabled !== policy.reminders) {
    if (activate) await plugin.setRemindersEnabled(policy.reminders, assertCurrent);
    else await plugin.writeRemindersSettings({ enabled: policy.reminders }, assertCurrent);
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
export function registerSharedFeatures(plugin: CratePlugin): void {
  let refreshing = false;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    void refreshSharedFeatures(plugin).catch(() => { /* Keep the last confirmed state offline. */ }).finally(() => { refreshing = false; });
  };
  plugin.registerInterval(window.setInterval(refresh, 30_000));
  plugin.registerDomEvent(window, 'focus', refresh);
  plugin.registerDomEvent(window, 'online', refresh);
  refresh();
}
