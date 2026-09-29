import React, { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { AppDock } from '../shared/navigation/AppDock';
import { DOCK_TABS, type DockTab } from '../shared/navigation/dock-destinations';
import type { TabId } from '@/reminders/ui/layoutConstants';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';

type RenderDock = (tab: TabId, onChange: (tab: TabId) => void, onAdd: (() => void) | undefined, inert: boolean) => React.ReactNode;
type ReadingDockProps = { activeTab: ReadingSection; onTabChange: (tab: ReadingSection) => void; onAdd: () => void; inert?: boolean };

/** Retain each visited feature in its Obsidian pane, including search and scroll. */
export function PluginWorkspaceNavigation({ initialSection = 'reminders', initialReminderTab = 'inbox', isFullScreen = false, remindersEnabled, readingEnabled, tabs, onTabsChange, renderReminders, renderReading }: {
  initialSection?: 'reminders' | 'reading';
  initialReminderTab?: TabId;
  isFullScreen?: boolean;
  remindersEnabled: boolean;
  readingEnabled: boolean;
  tabs: readonly DockTab[];
  onTabsChange: (tabs: DockTab[]) => void;
  renderReminders: (tab: TabId, onChange: (tab: TabId) => void, renderDock: RenderDock) => React.ReactNode;
  renderReading: (renderDock: (props: ReadingDockProps) => React.ReactNode) => React.ReactNode;
}) {
  const [section, setSection] = useState(initialSection);
  const [reminderTab, setReminderTab] = useState(initialReminderTab);
  const [readingTab, setReadingTab] = useState<ReadingSection>('inbox');
  const [visited, setVisited] = useState({ reminders: initialSection === 'reminders', reading: initialSection === 'reading' });
  const root = useRef<HTMLDivElement>(null);
  const [front, setFront] = useState(initialSection);
  const reduceMotion = useReducedMotion();
  const activeSection = section === 'reading' && readingEnabled ? 'reading' : remindersEnabled ? 'reminders' : 'reading';
  useLayoutEffect(() => {
    if (front === activeSection) return;
    const owner = root.current?.ownerDocument.defaultView ?? window;
    root.current?.querySelector<HTMLElement>('[data-active="true"] [data-dock-active="true"]')?.focus({ preventScroll: true });
    if (reduceMotion) { setFront(activeSection); return; }
    const timer = owner.setTimeout(() => setFront(activeSection), 1000);
    return () => owner.clearTimeout(timer);
  }, [activeSection, front, reduceMotion]);
  const panelStyle = (panel: 'reading' | 'reminders') => ({
    zIndex: panel === front ? 2 : 1,
    opacity: panel === front ? Number(panel === activeSection) : 1,
    visibility: panel !== front && panel !== activeSection ? 'hidden' as const : undefined,
    transition: panel === front ? 'opacity var(--pwa-motion-fade-duration) var(--pwa-motion-fade-ease)' : undefined,
  });
  const destinations = DOCK_TABS.filter(item => ['inbox', 'today', 'browse'].includes(item.id) ? remindersEnabled : readingEnabled);
  const visibleTabs = tabs.filter(tab => destinations.some(item => item.id === tab));
  const navigate = (tab: DockTab) => {
    if (tab === 'inbox' || tab === 'today' || tab === 'browse') {
      setReminderTab(tab); setSection('reminders'); setVisited(current => ({ ...current, reminders: true }));
    } else {
      setReadingTab(tab === 'reading' ? 'inbox' : tab === 'archive' ? 'archived' : tab);
      setSection('reading'); setVisited(current => ({ ...current, reading: true }));
    }
  };
  const pin = (tab: DockTab) => {
    const last = visibleTabs.at(-1);
    onTabsChange(tabs.map(item => item === last ? tab : item));
    navigate(tab);
  };
  const renderDock: RenderDock = (tab, onChange, onAdd, inert) => <AppDock section="reminders" tabs={visibleTabs} destinations={destinations}
    activeTab={tab === 'upcoming' ? 'today' : tab} onSelect={id => {
      if (id === 'inbox' || id === 'today' || id === 'browse') onChange(id);
      navigate(id);
    }} onPin={pin} onAdd={onAdd} inert={inert || activeSection !== 'reminders'} />;
  const renderReadingDock = (props: ReadingDockProps) => <WorkspaceReadingDock {...props} requestedTab={readingTab}
    tabs={visibleTabs} destinations={destinations} navigate={navigate} onPin={pin} inert={props.inert || activeSection !== 'reading'} />;
  return <div ref={root} className="plugin-workspace-navigation" onTransitionEnd={event => { if ((event.target as HTMLElement).parentElement === root.current && event.propertyName === 'opacity') setFront(activeSection); }} data-reduced-motion={reduceMotion || undefined} data-fullscreen={isFullScreen || undefined}>
    {remindersEnabled && (visited.reminders || activeSection === 'reminders') && <div className="plugin-workspace-panel" style={panelStyle('reminders')} data-active={activeSection === 'reminders'} inert={activeSection !== 'reminders'} aria-hidden={activeSection !== 'reminders'}>
      {renderReminders(reminderTab, setReminderTab, renderDock)}
    </div>}
    {readingEnabled && (visited.reading || activeSection === 'reading') && <div className="plugin-workspace-panel" style={panelStyle('reading')} data-active={activeSection === 'reading'} inert={activeSection !== 'reading'} aria-hidden={activeSection !== 'reading'}>
      {renderReading(renderReadingDock)}
    </div>}
  </div>;
}

function WorkspaceReadingDock({ activeTab, onTabChange, onAdd, inert, requestedTab, tabs, destinations, navigate, onPin }: ReadingDockProps & {
  requestedTab: ReadingSection;
  tabs: readonly DockTab[];
  destinations: readonly (typeof DOCK_TABS[number])[];
  navigate: (tab: DockTab) => void;
  onPin: (tab: DockTab) => void;
}) {
  const applyRequestedTab = useEffectEvent(onTabChange);
  useLayoutEffect(() => { applyRequestedTab(requestedTab); }, [requestedTab]);
  return <AppDock section="reading" tabs={tabs} destinations={destinations} className="crate-reading__mobile-nav"
    activeTab={activeTab === 'inbox' ? 'reading' : activeTab === 'archived' ? 'archive' : activeTab}
    onSelect={navigate} onPin={onPin} onAdd={onAdd} inert={inert} />;
}
