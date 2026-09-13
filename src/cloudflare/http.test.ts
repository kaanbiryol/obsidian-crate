import { afterEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('obsidian', () => ({ requestUrl: request }));
import { obsidianHttpTransport } from './http';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('times out a hung request without reporting a definitive remote failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    let resolve!: (value: { status: number; text: string }) => void;
    request.mockReturnValue(new Promise(done => { resolve = done; }));
    const response = obsidianHttpTransport('https://api.cloudflare.com/test', { method: 'PUT' });
    const rejected = expect(response).rejects.toThrow('may still finish remotely');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    resolve({ status: 200, text: 'late success' });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
});
it('cleans up the deadline when the response arrives', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    request.mockResolvedValue({ status: 200, text: 'ok' });
    expect(await obsidianHttpTransport('https://api.cloudflare.com/test', { method: 'GET' })).toEqual({ status: 200, text: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
});
