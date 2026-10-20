import { afterEach, describe, expect, it, vi } from 'vitest';

import { prefersReducedMotion } from './animations';

describe('prefersReducedMotion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('respects Obsidian reduced motion even when the OS preference is off', () => {
    vi.stubGlobal('document', {
      body: { classList: { contains: (name: string) => name === 'reduce-motion' } },
    });
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(prefersReducedMotion()).toBe(true);
  });

  it('falls back to the operating-system preference', () => {
    vi.stubGlobal('document', {
      body: { classList: { contains: () => false } },
    });
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(prefersReducedMotion()).toBe(true);
  });
});
