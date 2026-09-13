import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient, type ApiHttpTransport } from './http';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';

beforeEach(() => { vi.stubGlobal('window', { setTimeout, clearTimeout }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function harness() {
  const transport = vi.fn<ApiHttpTransport>(async () => {
    const text = JSON.stringify({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [] });
    return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
  });
  return { transport, http: new WorkerApiHttpClient('https://test', 'token', transport) };
}
it('shares concurrent checks and rechecks after 30 seconds', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const { http, transport } = harness();
  await Promise.all(Array.from({ length: 4 }, () => http.getServerInfo()));
  await http.getServerInfo();
  expect(transport).toHaveBeenCalledTimes(1);
  now.mockReturnValue(30_001);
  await http.getServerInfo();
  expect(transport).toHaveBeenCalledTimes(2);
});
it('invalidates metadata on credential and sync lifecycle changes', async () => {
  const { http, transport } = harness();
  await http.getServerInfo();
  http.updateCredentials('https://other', 'new-token');
  await http.getServerInfo();
  const controller = new AbortController();
  http.setAbortSignal(controller.signal);
  await http.getServerInfo();
  expect(transport).toHaveBeenCalledTimes(3);
  controller.abort();
  await expect(http.getServerInfo()).rejects.toMatchObject({ name: 'AbortError' });
});
it('does not cache failed metadata requests', async () => {
  const { http, transport } = harness();
  transport.mockRejectedValueOnce(new Error('offline'));
  await expect(http.getServerInfo()).rejects.toThrow('offline');
  await http.getServerInfo();
  expect(transport).toHaveBeenCalledTimes(2);
});
it('checks compatibility once across concurrent mutations', async () => {
  const { http, transport } = harness();
  await Promise.all(Array.from({ length: 4 }, () => http.requestJson('/sync/batch-upload', { method: 'POST', body: '{}' })));
  expect(transport.mock.calls.filter(([request]) => request.url.endsWith('/.well-known/crate'))).toHaveLength(1);
  expect(transport.mock.calls.filter(([request]) => request.url.endsWith('/sync/batch-upload'))).toHaveLength(4);
});
it('rejects a check superseded by new credentials', async () => {
  const { http } = harness();
  const pending = http.getServerInfo();
  http.updateCredentials('https://other', 'new-token');
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await expect(http.getServerInfo()).resolves.toMatchObject({ service: 'crate' });
});
it('blocks mutations when the cached metadata is incompatible', async () => {
  const { http, transport } = harness();
  const text = JSON.stringify({ service: 'crate', serverVersion: 'future', protocol: { current: 99, oldestCompatible: 99 }, capabilities: [] });
  transport.mockResolvedValue({ status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer });
  await http.getServerInfo();
  await expect(http.requestJson('/sync/batch-upload', { method: 'POST' })).rejects.toMatchObject({ code: 'protocol_incompatible' });
  expect(transport).toHaveBeenCalledTimes(1);
});
