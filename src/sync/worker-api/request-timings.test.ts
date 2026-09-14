import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient, type ApiHttpTransport } from './http';
import { normalizeSyncTimings } from '../timings';
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

it('reports observed D1 usage with coverage for failures, partial metadata and older servers', async () => {
  const values = ['10:4:1', '20:7:0', undefined, '-1:20:1', '9007199254740992:0:1'];
  const http = new WorkerApiHttpClient('https://test', 'token', async () => {
    const value = values.shift();
    const headers: Record<string, string> = value ? { 'X-Crate-D1-Usage': value } : {};
    return { status: 200, headers, text: '{}', arrayBuffer: new ArrayBuffer(0) };
  });
  for (let i = 0; i < 5; i++) await http.requestJson('/health');
  const d1 = { rowsRead: 30, rowsWritten: 11, reportedRequests: 2, completeRequests: 1 };
  expect(http.getRequestTimings()).toMatchObject({ count: 5, d1 });
  const snapshot = http.getRequestTimings(); snapshot.d1!.rowsWritten = 99;
  expect(http.getRequestTimings().d1).toEqual(d1);
  expect(normalizeSyncTimings({ totalMs: 1, phases: {}, requests: http.getRequestTimings() })?.requests?.d1).toEqual(d1);
  http.resetRequestTimings(); expect(http.getRequestTimings().d1).toBeUndefined();
});
