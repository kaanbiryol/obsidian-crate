import { expect, it, vi } from 'vitest';
import { PlannedContent } from './planned-content';
import { computeHash } from './hasher';

it('reuses only byte-identical snapshots and consumes them once', async () => {
    const cache = new PlannedContent();
    const content = new Uint8Array([1, 2]).buffer;
    const digest = vi.spyOn(crypto.subtle, 'digest');
    cache.remember('note.md', content, 'planned-hash');
    expect(await cache.hash('note.md', content.slice(0))).toBe('planned-hash');
    expect(digest).not.toHaveBeenCalled();
    const edited = new Uint8Array([1, 3]).buffer;
    cache.remember('note.md', content, 'planned-hash');
    expect(await cache.hash('note.md', edited)).toBe(await computeHash(edited));
    expect(digest).toHaveBeenCalled();
    digest.mockRestore();
});

it('bounds retained bytes and clears snapshots', async () => {
    const cache = new PlannedContent(2);
    const content = new Uint8Array([1, 2]).buffer;
    cache.remember('first', content, 'first-hash');
    cache.remember('second', content, 'second-hash');
    expect(await cache.hash('second', content)).toBe(await computeHash(content));
    cache.clear();
    expect(await cache.hash('first', content)).toBe(await computeHash(content));
});
