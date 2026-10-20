import React, { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';
import type { Reminder } from '@/reminders/types/reminder';
import type CratePlugin from '@/main';

vi.mock('@/reminders/ui/plugin/ReminderCardWrapper', () => ({
  ReminderCardWrapper: ({ reminder }: { reminder: Reminder }) => React.createElement('div', { className: 'card' }, reminder.content),
}));
vi.mock('@/reminders/ui/hooks/useObsidianDarkMode', () => ({ useObsidianDarkMode: () => false }));
vi.mock('@/ui/shared/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/ui/obsidian-icon', () => ({ ObsidianIcon: () => null }));
vi.mock('./styles.scss', () => ({}));
vi.mock('@/reminders/ui/plugin/ShadowDOMButton', () => ({ ShadowDOMButton: () => null }));

import { DEFAULT_REMINDERS_SETTINGS, useRemindersSettingsStore } from '@/reminders/settings';
import { setupReminderBackend, stopReminderBackend } from '@/reminders/runtime';
import { PluginContext } from '@/reminders/ui/plugin/reminders-context';
import { RemindersList } from './RemindersList';

const fixtures: Awaited<ReturnType<typeof createReminderByteVault>>[] = [];
const plugins: CratePlugin[] = [];
afterEach(async () => {
  for (const plugin of plugins.splice(0)) stopReminderBackend(plugin);
  for (const h of fixtures.splice(0)) await h.dispose();
});

async function createPlugin() {
  const h = await createReminderByteVault({
    'Reminders/Inbox.md': '- [ ] Task from the old folder <!-- crate-id:old -->\n',
    'Tasks/Inbox.md': '- [ ] Task from the new folder <!-- crate-id:new -->\n',
  });
  fixtures.push(h);
  Object.assign(h.vault, { on: () => ({}), offref: () => {} });
  Object.assign(h.app, { workspace: { layoutReady: true, onLayoutReady: () => {} } });
  useRemindersSettingsStore.setState({ ...DEFAULT_REMINDERS_SETTINGS, enabled: true }, true);
  const plugin = {
    app: h.app,
    manifest: { dir: '.obsidian/plugins/crate' },
    settings: { reading: { enabled: false, folderPath: 'Reading' } },
    get remindersSettings() { return useRemindersSettingsStore.getState(); },
    syncRuntime: {
      getState: () => ({ status: 'idle' }), getApiClient: () => null, isConfigured: () => false,
      addStateChangeListener: () => {}, removeStateChangeListener: () => {},
    },
    registerEvent: () => {},
  } as unknown as CratePlugin;
  plugins.push(plugin);
  return { plugin, h };
}

const cards = () => Array.from(document.querySelectorAll('.card'), card => card.textContent);

it('shows the new folder after the reminders folder changes while the list is open', async () => {
  const { plugin, h } = await createPlugin();
  expect(await setupReminderBackend(plugin, 'Reminders')).toBe(true);
  renderHook(() => null, () => {
    for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement']) vi.stubGlobal(name, (window as unknown as Record<string, unknown>)[name]);
    Object.assign(window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  }, () => React.createElement(PluginContext.Provider, { value: plugin }, React.createElement(RemindersList)));
  await act(async () => {});
  expect(cards()).toEqual(['Task from the old folder']);

  await act(async () => { await setupReminderBackend(plugin, 'Tasks'); });
  expect(cards()).toEqual(['Task from the new folder']);

  // The list follows edits in the new folder, not the replaced index.
  const file = await h.put('Tasks/Inbox.md', '- [ ] Edited in the new folder <!-- crate-id:new -->\n');
  await act(async () => { await plugin.reminderIndex.rescanFile(file); });
  expect(cards()).toEqual(['Edited in the new folder']);
});
