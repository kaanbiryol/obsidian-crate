import { AppDock } from '@/ui/shared/navigation/AppDock';
export { DockAddButton as PwaDockAddButton } from '@/ui/shared/navigation/AppDock';
import { useSharedFeatures } from '../shared-features';
import { DOCK_TABS, dockDestinationIndex, type DockTab } from '../dock-preferences';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import React, { useContext, useEffect, useEffectEvent, useLayoutEffect } from 'react';
import { useToast } from '../hooks/useToast';
import { PwaToast } from './PwaToast';
import type { NavigationItem } from '@/ui/shared/NavigationBar';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { FeatureNavigationContext, type CrateSection } from './FeatureSwitcherButton';

/** PWA navigation; shared feature panels supply their destinations and actions. */
export function PwaDock<T extends string>({ section, items, activeTab, onTabChange, onAdd, inert = false, disabled = false, className = '' }: {
  section: CrateSection;
  items: readonly NavigationItem<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  onAdd?: () => void;
  inert?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { preferences, updatePreferences } = usePwaPreferences();
  const { toast, showToast } = useToast();
  const features = useSharedFeatures();
  const allowed = (tab: string) => ['reading', 'favorites', 'archive', 'highlights'].includes(tab) ? features.reading : features.reminders;
  const tabs = preferences.dockTabs.filter(allowed);
  const navigation = useContext(FeatureNavigationContext);
  const activeIndex = dockDestinationIndex(tabs, section, activeTab);
  const currentTab = section === 'reading' ? activeTab === 'inbox' ? 'reading' : activeTab === 'archived' ? 'archive' : activeTab : activeTab === 'upcoming' ? 'today' : activeTab;
  const indicatorIndex = navigation?.dockIndex ?? activeIndex;
  const rememberReminderDockIndex = navigation?.rememberReminderDockIndex;
  useLayoutEffect(() => {
    if (section === 'reminders') rememberReminderDockIndex?.(activeIndex);
  }, [activeIndex, section, rememberReminderDockIndex]);
  const selectLocalTab = (tab: string) => {
    const item = items.find(candidate => candidate.id === tab);
    if (item && item.id !== activeTab) onTabChange(item.id);
  };
  const applyRequestedTab = useEffectEvent(selectLocalTab);
  const requested = navigation?.destination;
  useLayoutEffect(() => {
    if (requested?.section === section) applyRequestedTab(requested.tab);
  }, [requested, section]);
  const rememberReadingTab = navigation?.rememberReadingTab;
  useEffect(() => {
    if (section === 'reading') rememberReadingTab?.(activeTab as ReadingSection);
  }, [section, activeTab, rememberReadingTab]);
  const selectView = (tab: ReadingSection) => {
    if (section === 'reading') selectLocalTab(tab);
    else navigation?.navigate({ section: 'reading', tab });
  };
  const selectDockTab = (tab: DockTab) => {
    if (tab === 'reading' || tab === 'favorites' || tab === 'archive' || tab === 'highlights') {
      selectView(tab === 'reading' ? 'inbox' : tab === 'archive' ? 'archived' : tab);
    } else {
      if (section === 'reminders') selectLocalTab(tab);
      else navigation?.navigate({ section: 'reminders', tab });
    }
  };
  const selectPickerTab = (tab: DockTab) => {
    try {
      updatePreferences({ dockTabs: [...tabs.slice(0, -1), tab] });
    } catch {
      showToast('error', 'Could not save tabs on this device.');
      return;
    }
    selectDockTab(tab);
  };
  return <><AppDock section={section} tabs={tabs} destinations={DOCK_TABS.filter(item => allowed(item.id))} activeTab={currentTab as DockTab} activeIndex={indicatorIndex} onSelect={selectDockTab} onPin={selectPickerTab} onAdd={onAdd} inert={inert || navigation?.active === false} disabled={disabled} className={className} /><PwaToast toast={inert ? null : toast} /></>;
}
