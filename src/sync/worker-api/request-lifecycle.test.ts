import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient, type ApiHttpTransport } from './http';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());
function response(value: unknown) {
  const text = JSON.stringify(value);
  return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}
function harness() {
  const transport = vi.fn<ApiHttpTransport>(async () => response({
    service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [],
  }));
  return { transport, http: new WorkerApiHttpClient('https://old.example', 'old-token', transport) };
}

it.each(['credentials', 'signal'] as const)('rejects a mutation prepared before changing %s, even with cached metadata', async change => {
  const { http, transport } = harness();
  await http.getServerInfo();
  transport.mockClear();
  const writing = http.requestJson('/sync/batch-upload', { method: 'POST', body: '{}' });
  if (change === 'credentials') http.updateCredentials('https://new.example', 'new-token');
  else http.setAbortSignal(new AbortController().signal);
  await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
  expect(transport).not.toHaveBeenCalled();
  await http.requestJson('/sync/batch-upload', { method: 'POST', body: '{}' });
  expect(transport).toHaveBeenCalledTimes(2);
  const dispatched = transport.mock.lastCall?.[0];
  expect(dispatched?.url).toBe(`https://${change === 'credentials' ? 'new' : 'old'}.example/sync/batch-upload`);
  expect(dispatched?.headers?.Authorization).toBe(`Bearer ${change === 'credentials' ? 'new' : 'old'}-token`);
});

for (const kind of ['json', 'binary'] as const) it.each(['success', 'http error', 'network error'] as const)(`rejects an old ${kind} %s after replacing credentials`, async outcome => {
  const { http, transport } = harness();
  let release!: () => void;
  transport.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    if (outcome === 'network error') throw new Error('Old connection failed');
    if (outcome === 'http error') return { ...response({ error: 'Old credential expired' }), status: 401 };
    return response({ old: true });
  });
  const reading = kind === 'json' ? http.requestJson('/sync/manifest') : http.requestBinary('/sync/download');
  http.updateCredentials('https://new.example', 'new-token');
  release();
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
});
