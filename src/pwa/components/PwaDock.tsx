import { usePwaPreferences } from '../hooks/usePwaPreferences';
import React, { useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { PwaDockViewButton } from './PwaDockViewButton';
import { useDockMorph } from '../hooks/useDockMorph';
import { Button } from '@/ui/shared/Button';
import { ThemeIcon } from '@/reminders/components/theme-icon';
import type { NavigationItem } from '@/ui/shared/NavigationBar';
import { TABS } from '@/reminders/ui/layoutConstants';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { FeatureNavigationContext, type CrateSection } from './FeatureSwitcherButton';

const readingViews = [
  { id: 'inbox', label: 'Reading List', iconName: 'book-open' },
  { id: 'favorites', label: 'Favorites', iconName: 'star' },
  { id: 'archived', label: 'Archive', iconName: 'archive' },
  { id: 'highlights', label: 'Highlights', iconName: 'highlighter' },
] as const;
const reminderTabs = TABS.filter(item => item.id !== 'upcoming')
  .map(item => ({ ...item, label: item.id === 'today' ? 'Schedule' : item.label }));

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
  const { preferences } = usePwaPreferences();
  const tabs = preferences.dockTabs;
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
  const [previewTab, setPreviewTab] = useState<ReadingSection | null>(null);
  const readingTab = section === 'reading' ? activeTab : navigation?.readingTab ?? 'inbox';
  const groupItem = readingViews.find(item => item.id === readingTab) ?? readingViews[0];
  const activeReminderTab = activeTab === 'upcoming' ? 'today' : activeTab;
  const activeIndex = tabs.findIndex(tab => tab === (section === 'reading' ? 'reading' : activeReminderTab));
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
    if (section === 'reading') rememberReadingTab?.(groupItem.id);
  }, [section, groupItem.id, rememberReadingTab]);
  const selectView = (tab: ReadingSection) => {
    closeViews();
    if (section === 'reading') selectLocalTab(tab);
    else navigation?.navigate({ section: 'reading', tab });
  };
  const destinationAt = ({ x, y }: { x: number; y: number }): ReadingSection | null => {
    // Pointer capture keeps events on the trigger, so hit-test the visible choices.
    const buttons = container.current?.querySelectorAll<HTMLElement>('[data-dock-destination]');
    for (const button of Array.from(buttons ?? [])) {
      const rect = button.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return readingViews.find(item => item.id === button.dataset.dockDestination)?.id ?? null;
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
        {tabs.map(tab => {
          const item = reminderTabs.find(candidate => candidate.id === tab);
          return item ? <Button key={item.id} className={`pwa-dock__tab${section === 'reminders' && item.id === activeReminderTab ? ' is-active' : ''}`} data-dock-active={section === 'reminders' && item.id === activeReminderTab ? 'true' : undefined} aria-current={section === 'reminders' && item.id === activeReminderTab ? 'page' : undefined} aria-label={item.label} title={item.label} data-action="switch-tab" data-tab={item.id === 'browse' ? 'projects' : item.id} onClick={() => {
          if (section === 'reminders') selectLocalTab(item.id);
          else navigation?.navigate({ section: 'reminders', tab: item.id });
        }}><ThemeIcon id={item.iconName} size="l" aria-hidden="true" /></Button> : <PwaDockViewButton key={tab} label={groupItem.label} icon={groupItem.iconName} active={section === 'reading'} open={open} inert={inert} onSelect={() => selectView(groupItem.id)} onOpen={() => setOpen(true)}
          onDragStart={() => { setDragging(true); setOpen(true); setPreviewTab(null); }}
          onDragMove={point => setPreviewTab(destinationAt(point))}
          onDragEnd={(point, moved) => {
            const tab = moved ? destinationAt(point) : null;
            setDragging(false); setPreviewTab(null);
            if (tab !== null) selectView(tab);
            else if (moved) closeViews();
          }}
          onDragCancel={closeViews} />;
        })}
      </nav>
      <Dialog.Portal container={container} className="pwa-dock__portal">
        <Dialog.Backdrop className="pwa-dock__backdrop" />
        <Dialog.Popup ref={measureMenu} className="pwa-dock__menu" data-dragging={dragging ? 'true' : undefined} initialFocus={dragging ? false : undefined} finalFocus={() => container.current?.querySelector<HTMLElement>('[data-dock-group]') ?? false}>
          <Dialog.Title className="pwa-dock__sr">Reading views</Dialog.Title>
          {readingViews.map(item => <Button key={item.id} className="pwa-dock__destination" data-dock-destination={item.id} data-preview={previewTab === item.id ? 'true' : undefined} data-action="switch-reading-section" data-tab={item.id} aria-current={section === 'reading' && item.id === activeTab ? 'page' : undefined} onClick={() => selectView(item.id)}><ThemeIcon id={item.iconName} size="l" aria-hidden="true" /><span>{item.label}</span></Button>)}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
    {onAdd && <Button className="pwa-dock__add" disabled={disabled} aria-label={section === 'reading' ? 'Save a link' : 'Add reminder'} data-action={section === 'reminders' ? 'open-create-modal' : 'open-save-link'} onClick={onAdd}><ThemeIcon id="plus" size="l" aria-hidden="true" /></Button>}
  </div>;
}
