import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { Notice } from 'obsidian';
import type CratePlugin from '@/plugin/CratePlugin';
import { getReadingLibrary, subscribeReadingRuntime } from '@/reading/runtime';
import { LocalReadingLibrary } from '@/reading/ui/LocalReadingLibrary';
import { RemindersViewContent } from '@/reminders/ui/adapters/RemindersViewContent';
import { PluginContext } from '@/reminders/ui/reminders-context';
import { useRemindersSettingsStore } from '@/reminders/settings';
import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import { ObsidianIcon } from '@/reminders/components/obsidian-icon';
import { normalizeDockTabs, type DockTab } from '../shared/navigation/dock-destinations';
import { PluginWorkspaceNavigation } from './PluginWorkspaceNavigation';
import type { TabId } from '@/reminders/ui/layoutConstants';
import { useObsidianStatusBarInset } from '@/reminders/ui/hooks/useObsidianStatusBarInset';
import './plugin-navigation.scss';

const DOCK_KEY = 'crate-navigation-tabs';
export function PluginWorkspace({ plugin, shadowRoot, initialSection, initialReminderTab, initialProject, isFullScreen }: {
  plugin: CratePlugin; shadowRoot: ShadowRoot; initialSection?: 'reminders' | 'reading';
  initialReminderTab?: TabId; initialProject?: string; isFullScreen?: boolean;
}) {
  const subscribe = useCallback((listener: () => void) => subscribeReadingRuntime(plugin, listener), [plugin]);
  const getLibrary = useCallback(() => getReadingLibrary(plugin), [plugin]);
  const library = useSyncExternalStore(subscribe, getLibrary);
  const remindersEnabled = useRemindersSettingsStore(state => state.enabled);
  const [tabs, setTabs] = useState(() => {
    try { return normalizeDockTabs(plugin.app.loadLocalStorage(DOCK_KEY)); }
    catch { return normalizeDockTabs(null); }
  });
  useObsidianStatusBarInset(shadowRoot, true);
  const saveTabs = (next: DockTab[]) => {
    try { plugin.app.saveLocalStorage(DOCK_KEY, next); setTabs(next); }
    catch { new Notice('Could not save navigation tabs on this device.'); }
  };
  return <PluginContext.Provider value={plugin}><ThemeIconProvider renderer={ObsidianIcon}>
    <PluginWorkspaceNavigation isFullScreen={isFullScreen} initialSection={initialSection} initialReminderTab={initialProject ? 'browse' : initialReminderTab}
      remindersEnabled={remindersEnabled} readingEnabled={Boolean(library)} tabs={tabs} onTabsChange={saveTabs}
      renderReminders={(tab, onChange, renderNavigation) => <RemindersViewContent plugin={plugin}
        isFullScreen={isFullScreen} initialProject={initialProject} activeTab={tab} onTabChange={onChange} renderNavigation={renderNavigation} />}
      renderReading={renderNavigation => library && <LocalReadingLibrary plugin={plugin} library={library} renderNavigation={renderNavigation} />} />
  </ThemeIconProvider></PluginContext.Provider>;
}
