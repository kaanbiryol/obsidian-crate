import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import { calculateStableScrollAdjustment, useStableReminderScroll, type ReminderScrollAnchor } from './useStableReminderScroll';

const anchor = (id: string, section: string, top: number): ReminderScrollAnchor => ({
  id,
  section,
  top,
});

describe('calculateStableScrollAdjustment', () => {
  it('does not chase a completed reminder into another section', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('moving', 'active', 20), anchor('stable', 'active', 104)],
      [anchor('stable', 'active', 20), anchor('moving', 'completed', 320)],
    );

    expect(adjustment).toBeNull();
  });

  it('does not scroll to follow a reminder returning to active', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('moving', 'completed', 160)],
      [anchor('moving', 'active', 24)],
    );

    expect(adjustment).toBeNull();
  });

  it('lets visible neighbors animate when the destination is collapsed', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('moving', 'active', 20), anchor('stable', 'active', 104)],
      [anchor('stable', 'active', 20)],
    );

    expect(adjustment).toBeNull();
  });

  it('compensates when a reminder is inserted above the viewport', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('stable', 'active', -18)],
      [anchor('stable', 'active', 66)],
    );

    expect(adjustment).toBe(84);
  });

  it('preserves a row aligned exactly with the viewport edge', () => {
    expect(calculateStableScrollAdjustment(
      [anchor('stable', 'completed', 0)],
      [anchor('stable', 'completed', 84)],
    )).toBe(84);
  });

  it('preserves the first row when the viewport starts in a gap', () => {
    expect(calculateStableScrollAdjustment(
      [anchor('stable', 'completed', 6)],
      [anchor('stable', 'completed', 90)],
    )).toBe(84);
  });

  it('keeps a surviving neighbor when the clipped row leaves', () => {
    expect(calculateStableScrollAdjustment(
      [anchor('moving', 'completed', -18), anchor('stable', 'completed', 66)],
      [anchor('moving', 'active', -900), anchor('stable', 'completed', -18)],
    )).toBe(-84);
  });

  it('ignores section containers and never matches across sections', () => {
    expect(calculateStableScrollAdjustment(
      [anchor('completed-section', 'section', -500), anchor('stable', 'completed', -18)],
      [anchor('completed-section', 'section', -416), anchor('stable', 'active', 200)],
    )).toBeNull();
  });

  it('does not fight deliberate card reordering while stabilization is suspended', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('first', 'active', 18), anchor('second', 'active', 102)],
      [anchor('second', 'active', 18), anchor('first', 'active', 102)],
      true,
    );

    expect(adjustment).toBeNull();
  });
});

describe('useStableReminderScroll', () => {
  const counts = { resizeObservers: 0, mutationObservers: 0, offsetReads: 0 };
  let scrollTop = 0;

  function setup() {
    counts.resizeObservers = 0; counts.mutationObservers = 0; counts.offsetReads = 0;
    vi.stubGlobal('ResizeObserver', class { constructor() { counts.resizeObservers++; } observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('MutationObserver', class { constructor() { counts.mutationObservers++; } observe() {} disconnect() {} });
    Object.assign(window, { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  }

  function makeContainer() {
    const container = document.createElement('div');
    scrollTop = 0;
    Object.defineProperties(container, {
      offsetTop: { value: 0 }, offsetParent: { value: null }, clientHeight: { value: 100 },
      scrollTop: { get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
    });
    return container;
  }

  function setRows(container: HTMLElement, ids: string[]) {
    container.replaceChildren(...ids.map((id, index) => {
      const row = document.createElement('div');
      row.setAttribute('data-reminder-scroll-anchor', '');
      row.dataset.reminderId = id;
      row.dataset.reminderSection = 'active';
      Object.defineProperties(row, {
        offsetTop: { get: () => { counts.offsetReads++; return index * 50; } },
        offsetParent: { value: null }, offsetHeight: { value: 50 },
      });
      return row;
    }));
  }

  it('keeps observers across renders and anchors rows without measuring on scroll', () => {
    const hook = renderHook(() => useStableReminderScroll(), setup);
    const container = makeContainer();
    setRows(container, ['a', 'b', 'c', 'd', 'e']);
    hook.current.current = container;
    scrollTop = 60;
    for (let i = 0; i < 5; i++) hook.rerender();
    expect(counts.resizeObservers).toBe(1);
    expect(counts.mutationObservers).toBe(1);

    // Scrolling records the position without measuring rows.
    const reads = counts.offsetReads;
    scrollTop = 80;
    container.dispatchEvent(new window.Event('scroll'));
    expect(counts.offsetReads).toBe(reads);

    // A row inserted above keeps the clipped top row in place.
    setRows(container, ['new', 'a', 'b', 'c', 'd', 'e']);
    hook.rerender();
    expect(scrollTop).toBe(130);

    hook.unmount();
    expect(counts.resizeObservers).toBe(1);
  });
});
