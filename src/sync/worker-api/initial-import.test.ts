import { afterEach, expect, it, vi } from 'vitest';
import { InitialImportApi } from './initial-import';
import { INITIAL_IMPORT_CAPABILITY } from '@/protocol/initial-import';

afterEach(() => vi.useRealTimers());
function harness() {
  const requestJson = vi.fn();
  const api = new InitialImportApi({ requestJson, getWorkerUrl: () => 'https://test',
    getServerInfo: async () => ({ capabilities: [INITIAL_IMPORT_CAPABILITY] }) } as never);
  return { api, requestJson };
}

it('waits for schedules before treating a vault as established', async () => {
  vi.useFakeTimers();
  const { api, requestJson } = harness();
  requestJson.mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({ ready: true });
  let finished = false;
  const waiting = api.waitUntilReady('token', () => {}).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(500);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(500); await waiting;
  expect(await api.begin()).toBeNull();
  expect(requestJson).toHaveBeenCalledTimes(2);
});

it('preserves a completed-upload session for retry after a reminder error', async () => {
  const { api, requestJson } = harness();
  requestJson.mockResolvedValueOnce({ ready: false, error: 'Duplicate reminder identity' })
    .mockResolvedValueOnce({ import: { token: 'token', state: 'complete' } });
  await expect(api.waitUntilReady('token', () => {})).rejects.toThrow('Files uploaded. Reminder setup needs attention');
  expect(await api.begin()).toEqual({ token: 'token', state: 'complete' });
});

it('stops polling when the sync is cancelled', async () => {
  vi.useFakeTimers();
  const { api, requestJson } = harness();
  requestJson.mockResolvedValue({ ready: false });
  let cancelled = false;
  const pending = api.waitUntilReady('token', () => { if (cancelled) throw new Error('cancelled'); });
  const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.advanceTimersByTimeAsync(500); cancelled = true;
  await vi.advanceTimersByTimeAsync(500); await rejected;
  expect(requestJson).toHaveBeenCalledOnce();
});

it('reports live remaining work while polling and accepts older servers without progress', async () => {
  vi.useFakeTimers();
  const { api, requestJson } = harness();
  const progress = vi.fn();
  const counts = { scanning: false, remainingFiles: 0, remainingSchedules: 42 };
  requestJson.mockResolvedValueOnce({ ready: false, progress: counts })
    .mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({ ready: true });
  const waiting = api.waitUntilReady('token', () => {}, progress);
  await vi.advanceTimersByTimeAsync(2000); await waiting;
  expect(progress).toHaveBeenCalledExactlyOnceWith(counts);
});
