import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient, type ApiHttpTransport } from './http';
beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('aggregates every request, including failures, beyond the diagnostic history limit', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  let count = 0;
  const transport: ApiHttpTransport = async () => {
    now += 10; if (++count === 61) throw new Error('offline');
    return { status: 200, headers: { 'Server-Timing': 'crate;dur=4' }, text: '{}', arrayBuffer: new ArrayBuffer(0) };
  };
  const http = new WorkerApiHttpClient('https://test', 'token', transport);
  http.resetRequestTimings();
  for (let i = 0; i < 60; i++) await http.requestJson('/health');
  await expect(http.requestJson('/health')).rejects.toThrow('offline');
  expect(http.getRequestTimings()).toEqual({ count: 61, totalMs: 610, maxMs: 10, serverCount: 60, serverMs: 240 });
  expect(http.getRequestDiagnostics().requests).toHaveLength(50);
  http.resetRequestTimings(); expect(http.getRequestTimings().count).toBe(0);
});
it('does not attribute an earlier in-flight request to the next measurement', async () => {
  let release!: () => void;
  const http = new WorkerApiHttpClient('https://test', 'token', async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { status: 200, headers: {}, text: '{}', arrayBuffer: new ArrayBuffer(0) };
  });
  const pending = http.requestJson('/health');
  http.resetRequestTimings(); release(); await pending;
  expect(http.getRequestTimings().count).toBe(0);
});
