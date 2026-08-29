import { describe, expect, it } from 'vitest';
import { calculateStableScrollAdjustment, type ReminderScrollAnchor } from './useStableReminderScroll';

const anchor = (id: string, section: string, top: number): ReminderScrollAnchor => ({
  id,
  section,
  top,
});

describe('calculateStableScrollAdjustment', () => {
  it('keeps the moving reminder on screen when its destination is visible', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('moving', 'active', 20), anchor('stable', 'active', 104)],
      [anchor('stable', 'active', 20), anchor('moving', 'completed', 320)],
    );

    expect(adjustment).toBe(300);
  });

  it('follows a reminder returning to the active section', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('moving', 'completed', 160)],
      [anchor('moving', 'active', 24)],
    );

    expect(adjustment).toBe(-136);
  });

  it('falls back to an unchanged reminder when the destination is collapsed', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('moving', 'active', 20), anchor('stable', 'active', 104)],
      [anchor('stable', 'active', 20)],
    );

    expect(adjustment).toBe(-84);
  });

  it('compensates when a reminder is inserted above the viewport', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('stable', 'active', 18)],
      [anchor('new', 'active', 18), anchor('stable', 'active', 102)],
    );

    expect(adjustment).toBe(84);
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
