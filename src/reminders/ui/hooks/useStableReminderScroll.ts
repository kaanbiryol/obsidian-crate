import { useLayoutEffect, useRef, type RefObject } from 'react';

export interface ReminderScrollAnchor {
  id: string;
  section: string;
  top: number;
}

function layoutOffsetTop(element: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

export function calculateStableScrollAdjustment(
  previous: ReminderScrollAnchor[],
  current: ReminderScrollAnchor[],
  suspended = false,
): number | null {
  if (suspended) return null;

  const currentById = new Map<string, ReminderScrollAnchor[]>();
  for (const anchor of current) {
    const matches = currentById.get(anchor.id) ?? [];
    matches.push(anchor);
    currentById.set(anchor.id, matches);
  }

  for (const anchor of previous) {
    const movedMatch = currentById.get(anchor.id)
      ?.find((match) => match.section !== anchor.section);
    if (movedMatch) return movedMatch.top - anchor.top;
  }

  const currentByKey = new Map(
    current.map((anchor) => [`${anchor.section}\u0000${anchor.id}`, anchor]),
  );

  for (const anchor of previous) {
    const match = currentByKey.get(`${anchor.section}\u0000${anchor.id}`);
    if (match) return match.top - anchor.top;
  }

  return null;
}

function captureVisibleAnchors(container: HTMLElement): ReminderScrollAnchor[] {
  const containerTop = layoutOffsetTop(container);
  const viewportHeight = container.clientHeight;

  return Array.from(container.querySelectorAll<HTMLElement>('[data-reminder-scroll-anchor]'))
    .map((element) => {
      const top = layoutOffsetTop(element) - containerTop - container.scrollTop;
      return {
        id: element.dataset.reminderId ?? '',
        section: element.dataset.reminderSection ?? '',
        top,
        height: element.offsetHeight,
      };
    })
    .filter((anchor) => (
      Boolean(anchor.id)
      && anchor.top + anchor.height > 0
      && anchor.top < viewportHeight
    ));
}

/**
 * Keeps a visible moving reminder, or the first unchanged fallback, at the
 * same screen position while cards change sections.
 */
export function useStableReminderScroll(suspended = false): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousAnchorsRef = useRef<ReminderScrollAnchor[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const currentAnchors = captureVisibleAnchors(container);
    const adjustment = calculateStableScrollAdjustment(
      previousAnchorsRef.current,
      currentAnchors,
      suspended,
    );

    if (adjustment !== null && Math.abs(adjustment) > 0.5) {
      container.scrollTop += adjustment;
    }

    previousAnchorsRef.current = captureVisibleAnchors(container);
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const captureCurrentViewport = () => {
      previousAnchorsRef.current = captureVisibleAnchors(container);
    };
    const visualViewport = window.visualViewport;

    container.addEventListener('scroll', captureCurrentViewport, { passive: true });
    container.addEventListener('pointerdown', captureCurrentViewport, true);
    window.addEventListener('resize', captureCurrentViewport);
    visualViewport?.addEventListener('resize', captureCurrentViewport);
    return () => {
      container.removeEventListener('scroll', captureCurrentViewport);
      container.removeEventListener('pointerdown', captureCurrentViewport, true);
      window.removeEventListener('resize', captureCurrentViewport);
      visualViewport?.removeEventListener('resize', captureCurrentViewport);
    };
  });

  return containerRef;
}
