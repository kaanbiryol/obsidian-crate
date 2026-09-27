import React, { useCallback, useEffect, useId, useRef } from 'react';
import { ChevronUp } from 'lucide-react';
import { Button } from '@/ui/shared/Button';
import { ThemeIcon } from '@/reminders/components/theme-icon';

type Point = { x: number; y: number };
type Gesture = { pointerId: number; button: HTMLButtonElement; start: Point; choosing: boolean; moved: boolean };

/** Tap selects the slot’s destination; hold or slide up to choose in one gesture. */
export function PwaDockViewButton({ label, icon, active, open, inert, onSelect, onOpen, onDragStart, onDragMove, onDragEnd, onDragCancel }: {
  label: string; icon: string; active: boolean; open: boolean; inert: boolean;
  onSelect: () => void; onOpen: () => void;
  onDragStart: () => void; onDragMove: (point: Point) => void;
  onDragEnd: (point: Point, moved: boolean) => void; onDragCancel: () => void;
}) {
  const description = useId();
  const initialIcon = useRef(icon);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const current = gesture.current;
    gesture.current = null;
    if (current?.button.hasPointerCapture(current.pointerId)) current.button.releasePointerCapture(current.pointerId);
  }, []);
  const cancel = useCallback(() => {
    const choosing = gesture.current?.choosing;
    suppressClick.current = true;
    clear();
    if (choosing) onDragCancel();
  }, [clear, onDragCancel]);
  useEffect(() => {
    if (inert) cancel();
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', cancel);
    return () => { clear(); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', cancel); };
  }, [cancel, clear, inert]);
  useEffect(() => { if (!open && gesture.current?.choosing) clear(); }, [open, clear]);
  const beginChoosing = () => {
    const current = gesture.current;
    if (!current || !current.button.isConnected || current.button.closest('[inert]')) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    current.choosing = true;
    suppressClick.current = true;
    onDragStart();
  };
  // Covered navigation stays painted; inert blocks input without disabled dimming.
  return <>
    <Button className={`pwa-dock__tab pwa-dock__group${active ? ' is-active' : ''}`} data-dock-group="true" data-dock-switcher="true" data-dock-active={active ? 'true' : undefined} aria-current={active ? 'page' : undefined} aria-label={label} aria-describedby={description} aria-haspopup="dialog" aria-expanded={open} inert={inert} title={`${label} · Hold or slide up to switch views`}
      onPointerDown={event => {
        cancel();
        suppressClick.current = false;
        if (!event.isPrimary || event.button !== 0 || inert) return;
        const button = event.currentTarget;
        button.setPointerCapture(event.pointerId);
        gesture.current = { pointerId: event.pointerId, button, start: { x: event.clientX, y: event.clientY }, choosing: false, moved: false };
        timer.current = setTimeout(beginChoosing, 420);
      }}
      onPointerMove={event => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const point = { x: event.clientX, y: event.clientY };
        const dx = point.x - current.start.x, dy = point.y - current.start.y;
        if (Math.hypot(dx, dy) > 9) {
          current.moved = true;
          if (!current.choosing) {
            if (dy < -9 && -dy > Math.abs(dx)) beginChoosing();
            else { cancel(); return; }
          }
        }
        if (current.choosing) onDragMove(point);
      }}
      onPointerUp={event => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        clear();
        if (current.choosing) onDragEnd({ x: event.clientX, y: event.clientY }, current.moved);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={() => { if (gesture.current) cancel(); }}
      onClick={() => { if (!suppressClick.current) onSelect(); suppressClick.current = false; }}
      onContextMenu={event => {
        event.preventDefault();
        // A native touch contextmenu must not interrupt the captured finger.
        if (gesture.current) { if (!gesture.current.choosing) beginChoosing(); return; }
        cancel(); onOpen();
      }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); cancel(); onOpen(); }
        else if (event.key === 'Enter' || event.key === ' ') suppressClick.current = false;
      }}>
      <ThemeIcon key={icon} id={icon} size="l" className="pwa-dock__view-icon" style={icon === initialIcon.current ? { animation: 'none' } : undefined} aria-hidden="true" /><span className="pwa-dock__group-hint" aria-hidden="true"><ChevronUp size={14} strokeWidth={2.5} /></span>
    </Button>
    <span id={description} className="pwa-dock__sr">Tap to open {label}. Hold or slide up, then drag to a view and release to select. Press Down arrow to choose Reading List, Favorites, Archive, or Highlights.</span>
  </>;
}
