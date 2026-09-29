import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { PWA_SURFACE_SPRING } from './motion';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { useMotionValue, useMotionValueEvent, useSpring } from 'motion/react';

/** Retained feature docks paint the same surface through a navigation handoff. */
export function useDockMorphState() {
  const height = useSpring(60, PWA_SURFACE_SPRING);
  const expandedHeight = useMotionValue(158);
  const owner = useRef<HTMLSpanElement | null>(null);
  return useMemo(() => ({ height, expandedHeight, owner }), [height, expandedHeight]);
}

export const DockMorphContext = createContext<ReturnType<typeof useDockMorphState> | null>(null);

/** One damped spring preserves both shape and velocity when the target changes. */
export function useDockMorph(open: boolean, menuHeight: number, inert: boolean) {
  const surface = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();
  const local = useDockMorphState();
  const { height, expandedHeight, owner } = useContext(DockMorphContext) ?? local;
  const paint = useCallback((value: number) => {
    const element = surface.current;
    if (!element) return;
    const menuSize = expandedHeight.get();
    const progress = Math.max(0, Math.min(1, (value - 60) / Math.max(1, menuSize - 60)));
    element.style.height = `${value}px`;
    element.style.borderRadius = `${32 - progress * 4}px`;
    // The popup lives in a portal beside the bar. Share the painted edge with
    // it so text never floats beyond the expanding material. Only the reveal
    // moves; the choices keep their final hit targets during a held gesture.
    const dock = element.closest<HTMLElement>('.pwa-dock');
    dock?.style.setProperty('--dock-menu-inset', `${Math.max(0, menuSize - value)}px`);
    dock?.style.setProperty('--dock-menu-opacity', `${Math.max(0, Math.min(1, (progress - 0.1) / 0.55))}`);
    dock?.style.setProperty('--dock-tabs-opacity', `${Math.max(0, 1 - progress * 5)}`);
  }, [expandedHeight]);
  useMotionValueEvent(height, 'change', paint);
  useMotionValueEvent(expandedHeight, 'change', () => paint(height.get()));
  useLayoutEffect(() => {
    // The outgoing owner starts closing even while its destination is loading.
    // An inactive dock cannot overwrite a newly opened destination's target.
    if (inert && owner.current !== surface.current) return;
    owner.current = inert ? null : surface.current;
    if (open && !inert) expandedHeight.set(menuHeight);
    const target = open && !inert ? menuHeight : 60;
    if (reduceMotion) height.jump(target);
    else height.set(target);
  }, [height, expandedHeight, owner, open, menuHeight, inert, reduceMotion]);
  return useCallback((element: HTMLSpanElement | null) => {
    surface.current = element;
    paint(height.get());
  }, [height, paint]);
}
