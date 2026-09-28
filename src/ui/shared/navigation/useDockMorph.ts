import { useObsidianReducedMotion } from '@/reminders/ui/useObsidianReducedMotion';
import { PWA_SURFACE_SPRING } from './motion';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { useMotionValueEvent, useSpring } from 'motion/react';

/** One damped spring preserves both shape and velocity when the target changes. */
export function useDockMorph(open: boolean, menuHeight: number) {
  const surface = useRef<HTMLSpanElement>(null);
  const reduceMotion = useObsidianReducedMotion();
  const target = open ? menuHeight : 60;
  const height = useSpring(60, PWA_SURFACE_SPRING);
  const paint = useCallback((value: number) => {
    const element = surface.current;
    if (!element) return;
    const progress = Math.max(0, Math.min(1, (value - 60) / Math.max(1, menuHeight - 60)));
    element.style.height = `${value}px`;
    element.style.borderRadius = `${32 - progress * 4}px`;
    // The popup lives in a portal beside the bar. Share the painted edge with
    // it so text never floats beyond the expanding material. Only the reveal
    // moves; the choices keep their final hit targets during a held gesture.
    const dock = element.closest<HTMLElement>('.pwa-dock');
    dock?.style.setProperty('--dock-menu-inset', `${Math.max(0, menuHeight - value)}px`);
    dock?.style.setProperty('--dock-menu-opacity', `${Math.max(0, Math.min(1, (progress - 0.1) / 0.55))}`);
    dock?.style.setProperty('--dock-tabs-opacity', `${Math.max(0, 1 - progress * 5)}`);
  }, [menuHeight]);
  useMotionValueEvent(height, 'change', paint);
  useLayoutEffect(() => { paint(height.get()); }, [height, paint]);
  useLayoutEffect(() => {
    if (reduceMotion) height.jump(target);
    else height.set(target);
  }, [height, target, reduceMotion]);
  return surface;
}
