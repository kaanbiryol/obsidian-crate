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
