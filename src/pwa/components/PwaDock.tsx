import { useSharedFeatures } from '../shared-features';
import { DOCK_TABS, dockDestinationIndex, type DockTab } from '../dock-preferences';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import React, { useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { useToast } from '../hooks/useToast';
import { PwaToast } from './PwaToast';
import { PwaDockViewButton } from './PwaDockViewButton';
import { useDockMorph } from '../hooks/useDockMorph';
import { Button } from '@/ui/shared/Button';
import { ThemeIcon } from '@/reminders/components/theme-icon';
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
  const container = useRef<HTMLDivElement>(null);
  const [menuHeight, setMenuHeight] = useState(158);
  const measureMenu = useCallback((menu: HTMLDivElement | null) => {
    if (!menu) return;
    // Measure layout, not animation transforms; keep the finger's targets still.
    const update = () => setMenuHeight(menu.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(menu);
    return () => observer.disconnect();
  }, []);
  const [open, setOpen] = useState(false);
  const surface = useDockMorph(open, menuHeight);
  const [dragging, setDragging] = useState(false);
  const [previewTab, setPreviewTab] = useState<DockTab | null>(null);
  const activeIndex = dockDestinationIndex(tabs, section, activeTab);
  const currentTab = section === 'reading' ? activeTab === 'inbox' ? 'reading' : activeTab === 'archived' ? 'archive' : activeTab : activeTab === 'upcoming' ? 'today' : activeTab;
  const overflowTabs = DOCK_TABS.filter(item => allowed(item.id) && !tabs.includes(item.id));
  const indicatorIndex = navigation?.dockIndex ?? activeIndex;
  const rememberReminderDockIndex = navigation?.rememberReminderDockIndex;
  useLayoutEffect(() => {
    if (section === 'reminders') rememberReminderDockIndex?.(activeIndex);
  }, [activeIndex, section, rememberReminderDockIndex]);
  const closeViews = useCallback(() => { setOpen(false); setDragging(false); setPreviewTab(null); }, []);
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
    closeViews();
    if (section === 'reading') selectLocalTab(tab);
    else navigation?.navigate({ section: 'reading', tab });
  };
  const selectDockTab = (tab: DockTab) => {
    if (tab === 'reading' || tab === 'favorites' || tab === 'archive' || tab === 'highlights') {
      selectView(tab === 'reading' ? 'inbox' : tab === 'archive' ? 'archived' : tab);
    } else {
      closeViews();
      if (section === 'reminders') selectLocalTab(tab);
      else navigation?.navigate({ section: 'reminders', tab });
    }
  };
  const selectPickerTab = (tab: DockTab) => {
    try {
      updatePreferences({ dockTabs: [...tabs.slice(0, -1), tab] });
    } catch {
      closeViews();
      showToast('error', 'Could not save tabs on this device.');
      return;
    }
    selectDockTab(tab);
  };
  const destinationAt = ({ x, y }: { x: number; y: number }): DockTab | null => {
    // Pointer capture keeps events on the trigger, so hit-test the visible choices.
    const buttons = container.current?.querySelectorAll<HTMLElement>('[data-dock-destination]');
    for (const button of Array.from(buttons ?? [])) {
      const rect = button.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return overflowTabs.find(item => item.id === button.dataset.dockDestination)?.id ?? null;
      }
    }
    return null;
  };
  useEffect(() => { if (inert) closeViews(); }, [inert, closeViews]);
  return <div ref={container} className={`pwa-dock ${className}`} data-views-open={open ? 'true' : undefined} inert={inert}>
    <Dialog.Root open={open} onOpenChange={value => { if (value) setOpen(true); else closeViews(); }} modal={!dragging}>
      <nav className="pwa-dock__bar" aria-label="Main navigation">
        <span ref={surface} className="pwa-dock__surface" aria-hidden="true" />
        <span className="pwa-dock__indicator" aria-hidden="true" style={{ opacity: indicatorIndex < 0 ? 0 : undefined, width: `calc((100% - 8px) / ${tabs.length})`, transform: `translateX(${indicatorIndex * 100}%)` }} />
        {tabs.map((tab, index) => {
          const item = DOCK_TABS.find(candidate => candidate.id === tab)!;
          const readingView = tab === 'favorites' || tab === 'archive' || tab === 'highlights';
          const selected = tabs[activeIndex] === tab;
          const label = item.label;
          const icon = item.iconName;
          const select = () => selectDockTab(tab);
          return index !== tabs.length - 1 ? <Button key={tab} className={`pwa-dock__tab${selected ? ' is-active' : ''}`} data-dock-active={selected ? 'true' : undefined} aria-current={selected ? 'page' : undefined} aria-label={label} title={label} data-action={readingView || tab === 'reading' ? 'switch-reading-section' : 'switch-tab'} data-tab={tab === 'reading' ? 'inbox' : tab === 'browse' ? 'projects' : tab === 'archive' ? 'archived' : tab} onClick={select}><ThemeIcon id={icon} size="l" aria-hidden="true" /></Button> : <PwaDockViewButton key="picker" label={label} icon={icon} active={selected} open={open} inert={inert} onSelect={select} onOpen={() => setOpen(true)}
          onDragStart={() => { setDragging(true); setOpen(true); setPreviewTab(null); }}
          onDragMove={point => setPreviewTab(destinationAt(point))}
          onDragEnd={(point, moved) => {
            const tab = moved ? destinationAt(point) : null;
            setDragging(false); setPreviewTab(null);
            if (tab !== null) selectPickerTab(tab);
            else if (moved) closeViews();
          }}
          onDragCancel={closeViews} />;
        })}
      </nav>
      <Dialog.Portal container={container} className="pwa-dock__portal">
        <Dialog.Backdrop className="pwa-dock__backdrop" />
        <Dialog.Popup ref={measureMenu} className="pwa-dock__menu" data-dragging={dragging ? 'true' : undefined} initialFocus={dragging ? false : undefined} finalFocus={() => container.current?.querySelector<HTMLElement>('[data-dock-group]') ?? false}>
          <Dialog.Title className="pwa-dock__sr">More views</Dialog.Title>
          <div className="pwa-dock__choices">{overflowTabs.map(item => <Button key={item.id} className="pwa-dock__destination" data-dock-destination={item.id} data-preview={previewTab === item.id ? 'true' : undefined} aria-current={item.id === currentTab ? 'page' : undefined} onClick={() => selectPickerTab(item.id)}><ThemeIcon id={item.iconName} size="l" aria-hidden="true" /><span>{item.label}</span></Button>)}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
    <PwaToast toast={inert ? null : toast} />
    {onAdd && <PwaDockAddButton section={section} disabled={disabled} onClick={onAdd} />}
  </div>;
}

/** Shared capture action for the main dock and detail screens. */
export function PwaDockAddButton({ section, disabled = false, onClick, className = '' }: {
  section: CrateSection;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return <Button className={`pwa-dock__add ${className}`} disabled={disabled} aria-label={section === 'reading' ? 'Save a link' : 'Add reminder'} data-action={section === 'reminders' ? 'open-create-modal' : 'open-save-link'} onClick={onClick}><ThemeIcon id="plus" size="l" aria-hidden="true" /></Button>;
}
