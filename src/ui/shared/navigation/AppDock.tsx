import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { DockViewButton } from './DockViewButton';
import { useDockMorph } from './useDockMorph';
import { Button } from '../Button';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { DOCK_TABS, type DockTab } from './dock-destinations';
import { motion, useMotionTemplate, type MotionValue } from 'motion/react';

/** Host-independent dock; the adapter owns destinations, preferences and routing. */
export function AppDock({ section, tabs, destinations = DOCK_TABS, activeTab, activeIndex = tabs.indexOf(activeTab), indicatorPosition, onSelect, onPin, onAdd, inert = false, disabled = false, className = '' }: {
  section: 'reminders' | 'reading';
  tabs: readonly DockTab[];
  destinations?: readonly (typeof DOCK_TABS[number])[];
  activeTab: DockTab;
  activeIndex?: number;
  /** Retained feature docks can follow one shared animated position. */
  indicatorPosition?: MotionValue<number>;
  onSelect: (tab: DockTab) => void;
  onPin: (tab: DockTab) => void;
  onAdd?: () => void;
  inert?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const indicatorTransform = useMotionTemplate`translateX(${indicatorPosition ?? activeIndex * 100}%)`;
  useLayoutEffect(() => {
    if (!indicatorPosition) return;
    const buttons = Array.from(container.current?.querySelectorAll<HTMLElement>('.pwa-dock__bar > button') ?? []);
    // Paint from the same spring as the pill. A separate color transition would
    // trail behind each new frame, especially when the slide reverses.
    const paint = (position: number) => buttons.forEach((button, index) => {
      const emphasis = Math.max(0, 1 - Math.abs(position / 100 - index));
      button.style.color = `color-mix(in srgb, var(--text-normal) ${emphasis * 100}%, var(--text-muted))`;
    });
    paint(indicatorPosition.get());
    return indicatorPosition.on('change', paint);
  }, [indicatorPosition, tabs]);
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
  const surface = useDockMorph(open, menuHeight, inert);
  const [dragging, setDragging] = useState(false);
  const [previewTab, setPreviewTab] = useState<DockTab | null>(null);
  const overflowTabs = destinations.filter(item => !tabs.includes(item.id));
  const [closingTabs, setClosingTabs] = useState<typeof overflowTabs | null>(null);
  const closeViews = useCallback(() => { setOpen(false); setDragging(false); setPreviewTab(null); }, []);
  const selectDockTab = (tab: DockTab) => { closeViews(); onSelect(tab); };
  const selectPickerTab = (tab: DockTab) => {
    // Pin immediately, but keep the departing choices still through the exit.
    setClosingTabs(overflowTabs); closeViews(); onPin(tab);
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
  return <div ref={container} className={`pwa-dock ${className}`} data-selection-motion={indicatorPosition ? 'spring' : undefined} data-views-open={open ? 'true' : undefined} inert={inert} aria-hidden={inert || undefined}>
    <Dialog.Root open={open} onOpenChange={value => { if (value) setOpen(true); else closeViews(); }} onOpenChangeComplete={value => { if (!value) setClosingTabs(null); }} modal={!dragging}>
      <nav className="pwa-dock__bar" aria-label="Main navigation">
        <span ref={surface} className="pwa-dock__surface" aria-hidden="true" />
        <motion.span className="pwa-dock__indicator" aria-hidden="true" style={{ opacity: activeIndex < 0 ? 0 : undefined, width: `calc((100% - 8px) / ${tabs.length})`, transform: indicatorPosition ? indicatorTransform : `translateX(${activeIndex * 100}%)`, transition: indicatorPosition ? 'none' : undefined }} />
        {tabs.map((tab, index) => {
          const item = destinations.find(candidate => candidate.id === tab)!;
          const readingView = tab === 'favorites' || tab === 'archive' || tab === 'highlights';
          const selected = activeIndex === index;
          const label = item.label;
          const icon = item.iconName;
          const select = () => selectDockTab(tab);
          return index !== tabs.length - 1 || overflowTabs.length === 0 ? <Button key={tab} className={`pwa-dock__tab${selected ? ' is-active' : ''}`} data-dock-active={selected ? 'true' : undefined} aria-current={selected ? 'page' : undefined} aria-label={label} title={label} data-action={readingView || tab === 'reading' ? 'switch-reading-section' : 'switch-tab'} data-tab={tab === 'reading' ? 'inbox' : tab === 'browse' ? 'projects' : tab === 'archive' ? 'archived' : tab} onClick={select}><ThemeIcon id={icon} size="l" aria-hidden="true" /></Button> : <DockViewButton key="picker" label={label} icon={icon} active={selected} open={open} inert={inert} onSelect={select} onOpen={() => setOpen(true)}
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
        <Dialog.Popup ref={measureMenu} className="pwa-dock__menu" data-dragging={dragging ? 'true' : undefined} initialFocus={dragging ? false : undefined} finalFocus={() => {
          const dock = container.current;
          const workspace = dock?.closest('.plugin-workspace-navigation, .crate-feature-shell');
          return workspace?.querySelector<HTMLElement>('.pwa-dock:not([inert]) [data-dock-group]') ?? dock?.querySelector<HTMLElement>('[data-dock-group]') ?? false;
        }}>
          <Dialog.Title className="pwa-dock__sr">More views</Dialog.Title>
          <div className="pwa-dock__choices">{(open ? overflowTabs : closingTabs ?? overflowTabs).map(item => <Button key={item.id} className="pwa-dock__destination" data-dock-destination={item.id} data-preview={previewTab === item.id ? 'true' : undefined} aria-current={item.id === activeTab ? 'page' : undefined} onClick={() => selectPickerTab(item.id)}><ThemeIcon id={item.iconName} size="l" aria-hidden="true" /><span>{item.label}</span></Button>)}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
    {onAdd && <DockAddButton section={section} disabled={disabled} onClick={onAdd} />}
  </div>;
}

/** Shared capture action for the main dock and detail screens. */
export function DockAddButton({ section, disabled = false, onClick, className = '' }: {
  section: 'reminders' | 'reading';
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return <Button className={`pwa-dock__add ${className}`} disabled={disabled} aria-label={section === 'reading' ? 'Save a link' : 'Add reminder'} data-action={section === 'reminders' ? 'open-create-modal' : 'open-save-link'} onClick={onClick}><ThemeIcon id="plus" size="l" aria-hidden="true" /></Button>;
}
