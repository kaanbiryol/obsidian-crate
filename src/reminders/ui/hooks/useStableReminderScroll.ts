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

  const currentByKey = new Map(
    current.map((anchor) => [`${anchor.section}\u0000${anchor.id}`, anchor]),
  );

  const rows = previous.filter(anchor => anchor.section !== 'section');
  for (const anchor of rows) {
    const match = currentByKey.get(`${anchor.section}\u0000${anchor.id}`);
    if (match) {
      return match.top - anchor.top;
    }
    // A visible row leaving should close its gap naturally. If the clipped
    // top row leaves, keep its surviving neighbor in place instead.
    if (anchor.top >= 0) return null;
  }

  return null;
}

function captureAnchors(container: HTMLElement, visibleOnly = false): ReminderScrollAnchor[] {
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
      && (!visibleOnly || (anchor.top + anchor.height > 0 && anchor.top < viewportHeight))
    ));
}

/** Keep the viewport anchored through both React commits and animated reflow. */
export function useStableReminderScroll(suspended = false): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousContainerRef = useRef<HTMLElement | null>(null);
  const previousAnchorsRef = useRef<ReminderScrollAnchor[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (previousContainerRef.current !== container) {
      previousContainerRef.current = container;
      previousAnchorsRef.current = [];
    }
    let lastScrollTop = container.scrollTop;
    const captureCurrentViewport = () => {
      previousAnchorsRef.current = captureAnchors(container, true);
      lastScrollTop = container.scrollTop;
    };
    const stabilize = () => {
      const adjustment = calculateStableScrollAdjustment(
        previousAnchorsRef.current,
        // The old anchor may have moved completely outside the viewport.
        captureAnchors(container),
        suspended,
      );
      if (adjustment !== null && Math.abs(adjustment) > 0.5) {
        container.scrollTop += adjustment;
      }
      captureCurrentViewport();
    };
    stabilize();

    // Height animations continue after the commit. Observe flow containers too:
    // their size includes changing margins and rows that are still exiting.
    const resizeObserver = new ResizeObserver(stabilize);
    const observed = new Set<Element>();
    const observeContent = () => {
      const elements = new Set<Element>([container, ...Array.from(container.querySelectorAll(
        '[data-reminder-scroll-anchor], .reminder-list-presence',
      ))]);
      for (const element of observed) {
        if (!elements.has(element)) {
          resizeObserver.unobserve(element);
          observed.delete(element);
        }
      }
      for (const element of elements) {
        if (!observed.has(element)) {
          resizeObserver.observe(element);
          observed.add(element);
        }
      }
    };
    observeContent();
    const mutationObserver = new MutationObserver(() => {
      observeContent();
      stabilize();
    });
    mutationObserver.observe(container, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-reminder-scroll-anchor'],
    });
    const handleScroll = () => {
      // Our own scroll event must not overwrite the anchor during a later frame.
      if (container.scrollTop !== lastScrollTop) captureCurrentViewport();
    };
    const visualViewport = window.visualViewport;
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('pointerdown', captureCurrentViewport, true);
    window.addEventListener('resize', captureCurrentViewport);
    visualViewport?.addEventListener('resize', captureCurrentViewport);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('pointerdown', captureCurrentViewport, true);
      window.removeEventListener('resize', captureCurrentViewport);
      visualViewport?.removeEventListener('resize', captureCurrentViewport);
    };
  });

  return containerRef;
}
