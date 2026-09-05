import { describe, expect, it } from 'vitest';
import { calculateStableScrollAdjustment, type ReminderScrollAnchor } from './useStableReminderScroll';

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

  it('does not fight deliberate card reordering while stabilization is suspended', () => {
    const adjustment = calculateStableScrollAdjustment(
      [anchor('first', 'active', 18), anchor('second', 'active', 102)],
      [anchor('second', 'active', 18), anchor('first', 'active', 102)],
      true,
    );

    expect(adjustment).toBeNull();
  });
});
