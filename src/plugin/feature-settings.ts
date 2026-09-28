import type CratePlugin from './CratePlugin';
import { readingServerRequest } from '../reading/server';
import { startReading, stopReading } from '../reading/runtime';
import { getPluginLifecycleSignal } from './lifecycle-state';

interface Features { reading: boolean; reminders: boolean; revision: string | null }
const tasks = new WeakMap<CratePlugin, Promise<void>>();
async function apply(plugin: CratePlugin, policy: Features, activate: boolean): Promise<void> {
  if (typeof policy.reading !== 'boolean' || typeof policy.reminders !== 'boolean') throw new Error('Could not read shared feature settings.');
  if (plugin.settings.reading.enabled !== policy.reading) {
    await plugin.writeSettings({ reading: { ...plugin.settings.reading, enabled: policy.reading } });
    stopReading(plugin);
    plugin.app.workspace.detachLeavesOfType('crate-reading');
    if (activate && policy.reading) startReading(plugin);
  }
  if (plugin.remindersSettings.enabled !== policy.reminders) {
    if (activate) await plugin.setRemindersEnabled(policy.reminders);
    else await plugin.writeRemindersSettings({ enabled: policy.reminders });
  }
}
function serialize(plugin: CratePlugin, action: () => Promise<void>): Promise<void> {
  const next = (tasks.get(plugin) ?? Promise.resolve()).catch(() => {}).then(action);
  tasks.set(plugin, next);
  return next;
}
export function refreshSharedFeatures(plugin: CratePlugin, activate = true): Promise<void> {
  return serialize(plugin, async () => {
    if (!plugin.settings.workerUrl || getPluginLifecycleSignal(plugin).aborted) return;
    const policy = await readingServerRequest<Features>(plugin, '/features');
    const changed = policy.reading !== plugin.settings.reading.enabled || policy.reminders !== plugin.remindersSettings.enabled;
    await apply(plugin, policy, activate);
    if (changed && activate) plugin.refreshSettingsTab();
  });
}
export function setSharedFeature(plugin: CratePlugin, feature: 'reading' | 'reminders', enabled: boolean): Promise<void> {
  return serialize(plugin, async () => {
    if (!plugin.settings.workerUrl) {
      await apply(plugin, { reading: plugin.settings.reading.enabled, reminders: plugin.remindersSettings.enabled, revision: null, [feature]: enabled }, true);
      return;
    }
    const current = await readingServerRequest<Features>(plugin, '/features');
    const policy = await readingServerRequest<Features>(plugin, '/features', { feature, enabled, revision: current.revision });
    await apply(plugin, policy, true);
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
