import { afterEach, expect, it, vi } from 'vitest';
import { browserStorageStatus } from './browser-storage';
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])('reports the browser persistence decision (%s)', async granted => {
 const persist = vi.fn().mockResolvedValue(granted);
 vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } });
 expect(await browserStorageStatus()).toBe('best-effort'); expect(persist).not.toHaveBeenCalled();
 expect(await browserStorageStatus(true)).toBe(granted ? 'persistent' : 'best-effort');
});
it('does not request persistence again when already granted', async () => {
 const persist = vi.fn(); vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } });
 expect(await browserStorageStatus(true)).toBe('persistent'); expect(persist).not.toHaveBeenCalled();
});
it.each([undefined, { persisted: () => { throw new Error('Unavailable'); } }])('handles unavailable browser storage', async storage => {
 vi.stubGlobal('navigator', {storage}); expect(await browserStorageStatus(true)).toBe('unavailable');
});
