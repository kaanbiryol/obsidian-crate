import { PWA_SURFACE_SPRING } from '../motion';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useMotionValueEvent, useSpring } from 'motion/react';

/** One damped spring preserves both shape and velocity when the target changes. */
export function useDockMorph(open: boolean, menuHeight: number) {
  const surface = useRef<HTMLSpanElement>(null);
  const target = open ? menuHeight : 60;
  const height = useSpring(60, PWA_SURFACE_SPRING);
  useMotionValueEvent(height, 'change', value => {
    const element = surface.current;
    if (!element) return;
    const progress = Math.max(0, Math.min(1, (value - 60) / Math.max(1, menuHeight - 60)));
    element.style.height = `${value}px`;
    element.style.borderRadius = `${32 - progress * 4}px`;
  });
  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) height.jump(target);
    else height.set(target);
  }, [height, target]);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => { if (reduced.matches) height.jump(target); };
    reduced.addEventListener('change', onPreference);
    return () => reduced.removeEventListener('change', onPreference);
  }, [height, target]);
  return surface;
}
