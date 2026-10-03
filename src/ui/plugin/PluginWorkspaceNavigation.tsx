import React, { useCallback, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { AppDock } from '../shared/navigation/AppDock';
import { DOCK_TABS, dockDestinationIndex, type DockTab } from '../shared/navigation/dock-destinations';
import type { TabId } from '@/reminders/ui/layoutConstants';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { useSpring, type MotionValue } from 'motion/react';
import { PWA_CONTROL_SPRING } from '../shared/navigation/motion';
import { DockMorphContext, useDockMorphState } from '../shared/navigation/useDockMorph';

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
  const dockMorph = useDockMorphState();
  const [front, setFront] = useState(initialSection);
  const [transitioning, setTransitioning] = useState(false);
  const reduceMotion = useReducedMotion();
  const activeSection = section === 'reading' && readingEnabled ? 'reading' : remindersEnabled ? 'reminders' : 'reading';
  const switchingSection = transitioning || front !== activeSection;
  const finishSectionTransition = useCallback(() => {
    setFront(activeSection);
    setTransitioning(false);
  }, [activeSection]);
  const finishSettledSection = useCallback(() => {
    const panel = root.current?.querySelector<HTMLElement>('.plugin-workspace-panel[data-front="true"]');
    if (panel && (panel.ownerDocument.defaultView ?? window).getComputedStyle(panel).opacity === panel.style.opacity) finishSectionTransition();
  }, [finishSectionTransition]);
  useLayoutEffect(() => {
    if (!switchingSection) return;
    const owner = root.current?.ownerDocument.defaultView ?? window;
    root.current?.querySelector<HTMLElement>('[data-active="true"] [data-dock-active="true"]')?.focus({ preventScroll: true });
    if (reduceMotion) { finishSectionTransition(); return; }
    const frame = owner.requestAnimationFrame(finishSettledSection);
    const timer = owner.setTimeout(finishSectionTransition, 1000);
    return () => { owner.cancelAnimationFrame(frame); owner.clearTimeout(timer); };
  }, [activeSection, switchingSection, reduceMotion, finishSectionTransition, finishSettledSection]);
  const panelStyle = (panel: 'reading' | 'reminders') => ({
    zIndex: panel === front ? 2 : 1,
    opacity: panel === front ? Number(panel === activeSection) : 1,
    visibility: panel !== front && panel !== activeSection ? 'hidden' as const : undefined,
    transition: panel === front ? 'opacity var(--pwa-motion-tab-duration) var(--pwa-motion-tab-ease)' : undefined,
  });
  const destinations = DOCK_TABS.filter(item => ['inbox', 'today', 'browse'].includes(item.id) ? remindersEnabled : readingEnabled);
  const visibleTabs = tabs.filter(tab => destinations.some(item => item.id === tab));
  const activeIndex = dockDestinationIndex(visibleTabs, activeSection, activeSection === 'reading' ? readingTab : reminderTab);
  // Both painted docks follow the same spring, including a feature's first mount.
  const indicatorPosition = useSpring(activeIndex * 100, PWA_CONTROL_SPRING);
  const previousIndex = useRef(activeIndex);
  useLayoutEffect(() => {
    if (reduceMotion || activeIndex < 0 || previousIndex.current < 0) indicatorPosition.jump(activeIndex * 100);
    else indicatorPosition.set(activeIndex * 100);
    previousIndex.current = activeIndex;
  }, [activeIndex, reduceMotion, indicatorPosition]);
  const navigate = (tab: DockTab) => {
    if (tab === 'inbox' || tab === 'today' || tab === 'browse') {
      if (activeSection !== 'reminders') setTransitioning(true);
      setReminderTab(tab); setSection('reminders'); setVisited(current => ({ ...current, reminders: true }));
    } else {
      if (activeSection !== 'reading') setTransitioning(true);
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
    activeIndex={activeIndex} indicatorPosition={indicatorPosition}
    activeTab={tab === 'upcoming' ? 'today' : tab} onSelect={id => {
      if (id === 'inbox' || id === 'today' || id === 'browse') onChange(id);
      navigate(id);
    }} onPin={pin} onAdd={onAdd} inert={inert || activeSection !== 'reminders'} />;
  const renderReadingDock = (props: ReadingDockProps) => <WorkspaceReadingDock {...props} requestedTab={readingTab}
    activeIndex={activeIndex} indicatorPosition={indicatorPosition}
    tabs={visibleTabs} destinations={destinations} navigate={navigate} onPin={pin} inert={props.inert || activeSection !== 'reading'} />;
  return <DockMorphContext.Provider value={dockMorph}><div ref={root} className="plugin-workspace-navigation" onTransitionEnd={event => { if ((event.target as HTMLElement).parentElement === root.current && event.propertyName === 'opacity') finishSettledSection(); }} data-reduced-motion={reduceMotion || undefined} data-fullscreen={isFullScreen || undefined}>
    {remindersEnabled && (visited.reminders || activeSection === 'reminders') && <div className="plugin-workspace-panel" style={panelStyle('reminders')} data-front={front === 'reminders'} data-active={activeSection === 'reminders'} data-entering={activeSection === 'reminders' && switchingSection} inert={activeSection !== 'reminders'} aria-hidden={activeSection !== 'reminders'}>
      {renderReminders(reminderTab, setReminderTab, renderDock)}
    </div>}
    {readingEnabled && (visited.reading || activeSection === 'reading') && <div className="plugin-workspace-panel" style={panelStyle('reading')} data-front={front === 'reading'} data-active={activeSection === 'reading'} data-entering={activeSection === 'reading' && switchingSection} inert={activeSection !== 'reading'} aria-hidden={activeSection !== 'reading'}>
      {renderReading(renderReadingDock)}
    </div>}
  </div></DockMorphContext.Provider>;
}

function WorkspaceReadingDock({ activeTab, onTabChange, onAdd, inert, requestedTab, tabs, destinations, navigate, onPin, activeIndex, indicatorPosition }: ReadingDockProps & {
  requestedTab: ReadingSection;
  tabs: readonly DockTab[];
  destinations: readonly (typeof DOCK_TABS[number])[];
  navigate: (tab: DockTab) => void;
  onPin: (tab: DockTab) => void;
  activeIndex: number;
  indicatorPosition: MotionValue<number>;
}) {
  const applyRequestedTab = useEffectEvent(onTabChange);
  useLayoutEffect(() => { applyRequestedTab(requestedTab); }, [requestedTab]);
  return <AppDock section="reading" tabs={tabs} destinations={destinations} className="crate-reading__mobile-nav"
    activeIndex={activeIndex} indicatorPosition={indicatorPosition}
    activeTab={activeTab === 'inbox' ? 'reading' : activeTab === 'archived' ? 'archive' : activeTab}
    onSelect={navigate} onPin={onPin} onAdd={onAdd} inert={inert} />;
}
