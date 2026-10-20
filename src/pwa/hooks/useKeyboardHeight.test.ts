import { describe, expect, it } from 'vitest';
import { calculateKeyboardInset } from './useKeyboardHeight';

describe('calculateKeyboardInset', () => {
  it('measures the obscured area from the layout and visual viewports', () => {
    expect(calculateKeyboardInset({
      layoutHeight: 844,
      visualHeight: 510,
      visualOffsetTop: 0,
    })).toBe(334);
  });

  it('accounts for a visual viewport shifted by browser chrome', () => {
    expect(calculateKeyboardInset({
      layoutHeight: 844,
      visualHeight: 500,
      visualOffsetTop: 44,
    })).toBe(300);
  });

  it('returns zero when the visible viewport fills or exceeds the layout', () => {
    expect(calculateKeyboardInset({
      layoutHeight: 844,
      visualHeight: 844,
      visualOffsetTop: 0,
    })).toBe(0);
    expect(calculateKeyboardInset({
      layoutHeight: 844,
      visualHeight: 820,
      visualOffsetTop: 30,
    })).toBe(0);
  });
});
