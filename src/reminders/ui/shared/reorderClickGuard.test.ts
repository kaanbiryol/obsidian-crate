import { describe, expect, it } from 'vitest';
import { createReorderClickGuard } from './reorderClickGuard';

describe('reorder click suppression', () => {
  const pointerClick = { detail: 1 };

  it('allows ordinary taps before any reorder', () => {
    expect(createReorderClickGuard().shouldBlock(pointerClick)).toBe(false);
  });

  it('blocks the release click and any delayed duplicate until a new press', () => {
    const guard = createReorderClickGuard();
    guard.block();
    expect(guard.shouldBlock(pointerClick)).toBe(true);
    expect(guard.shouldBlock(pointerClick)).toBe(true);
    guard.reset();
    expect(guard.shouldBlock(pointerClick)).toBe(false);
  });

  it('preserves keyboard activation after a reorder', () => {
    const guard = createReorderClickGuard();
    guard.block();
    expect(guard.shouldBlock({ detail: 0 })).toBe(false);
    expect(guard.shouldBlock(pointerClick)).toBe(true);
  });

  it('blocks a held gesture even when it is released without moving a row', () => {
    const guard = createReorderClickGuard();
    guard.reset();
    guard.block();
    expect(guard.shouldBlock(pointerClick)).toBe(true);
    guard.reset();
    guard.block();
    expect(guard.shouldBlock(pointerClick)).toBe(true);
  });
});
