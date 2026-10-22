import { useLayoutEffect, useRef, type RefObject } from 'react';
import { scrollPort } from '../../../../ui/shared/scroll-port';

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

interface MeasuredAnchor extends ReminderScrollAnchor {
  height: number;
}

interface ViewportSnapshot {
  anchors: MeasuredAnchor[];
  scrollTop: number;
  viewportHeight: number;
}

function captureAnchors(container: HTMLElement): MeasuredAnchor[] {
  const containerTop = layoutOffsetTop(container);
  const scrollTop = scrollPort(container).scrollTop;

  return Array.from(container.querySelectorAll<HTMLElement>('[data-reminder-scroll-anchor]'))
    .map((element) => ({
      id: element.dataset.reminderId ?? '',
      section: element.dataset.reminderSection ?? '',
      top: layoutOffsetTop(element) - containerTop - scrollTop,
      height: element.offsetHeight,
    }))
    .filter((anchor) => Boolean(anchor.id));
}

// Scrolling moves every row by the same distance, so the visible rows are
// derived from the last measurement instead of measuring on each scroll event.
function visibleAnchorsAt(snapshot: ViewportSnapshot, scrollTop: number): ReminderScrollAnchor[] {
  const offset = scrollTop - snapshot.scrollTop;
  return snapshot.anchors
    .map((anchor) => ({ ...anchor, top: anchor.top - offset }))
    .filter((anchor) => anchor.top + anchor.height > 0 && anchor.top < snapshot.viewportHeight);
}

function attachStableScroll(container: HTMLElement, isSuspended: () => boolean) {
  // The PWA can hand this list's scrolling to the document while its screen is settled.
  const port = () => scrollPort(container);
  let snapshot: ViewportSnapshot = { anchors: [], scrollTop: port().scrollTop, viewportHeight: port().clientHeight };
  let lastScrollTop = port().scrollTop;
  const captureCurrentViewport = () => {
    snapshot = { anchors: captureAnchors(container), scrollTop: port().scrollTop, viewportHeight: port().clientHeight };
    lastScrollTop = port().scrollTop;
  };
  const stabilize = () => {
    const scrollTop = port().scrollTop;
    // The old anchor may have moved completely outside the viewport.
    const current = captureAnchors(container);
    const adjustment = calculateStableScrollAdjustment(
      visibleAnchorsAt(snapshot, lastScrollTop),
      current,
      isSuspended(),
    );
    if (adjustment !== null && Math.abs(adjustment) > 0.5) {
      port().scrollTop += adjustment;
    }
    snapshot = { anchors: current, scrollTop, viewportHeight: port().clientHeight };
    lastScrollTop = port().scrollTop;
  };
  stabilize();

  // Height animations continue after the commit. Observe flow containers too:
  // their size includes changing margins and rows that are still exiting.
  // Register observations and adjust scrolling outside resize delivery. React
  // can otherwise replace these observations during WebKit's layout pass.
  let resizeFrame: number | undefined;
  const resizeObserver = new ResizeObserver(() => scheduleStabilization());
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
  const scheduleStabilization = () => {
    if (resizeFrame !== undefined) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = undefined;
      observeContent();
      stabilize();
    });
  };
  scheduleStabilization();
  const mutationObserver = new MutationObserver(scheduleStabilization);
  mutationObserver.observe(container, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-reminder-scroll-anchor'],
  });
  const handleScroll = () => {
    lastScrollTop = port().scrollTop;
  };
  const visualViewport = window.visualViewport;
  container.addEventListener('scroll', handleScroll, { passive: true });
  container.ownerDocument.addEventListener('scroll', handleScroll, { passive: true });
  container.addEventListener('pointerdown', captureCurrentViewport, true);
  window.addEventListener('resize', captureCurrentViewport);
  visualViewport?.addEventListener('resize', captureCurrentViewport);
  return {
    container,
    stabilize,
    dispose: () => {
      resizeObserver.disconnect();
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      mutationObserver.disconnect();
      container.removeEventListener('scroll', handleScroll);
      container.ownerDocument.removeEventListener('scroll', handleScroll);
      container.removeEventListener('pointerdown', captureCurrentViewport, true);
      window.removeEventListener('resize', captureCurrentViewport);
      visualViewport?.removeEventListener('resize', captureCurrentViewport);
    },
  };
}

/** Keep the viewport anchored through both React commits and animated reflow. */
export function useStableReminderScroll(suspended = false): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const suspendedRef = useRef(suspended);
  const sessionRef = useRef<ReturnType<typeof attachStableScroll> | null>(null);

  // Observers and listeners live as long as the container. Each later commit
  // only re-anchors the viewport synchronously, before the browser paints.
  useLayoutEffect(() => {
    suspendedRef.current = suspended;
    const container = containerRef.current;
    const session = sessionRef.current;
    if (session && session.container === container) {
      session.stabilize();
      return;
    }
    session?.dispose();
    sessionRef.current = container ? attachStableScroll(container, () => suspendedRef.current) : null;
  });
  useLayoutEffect(() => () => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, []);

  return containerRef;
}
