import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDiagnosticExport } from './diagnostic-export';
import { createRuntimeHarness } from './runtime-test-harness';
import { normalizeCrateSettings } from '../plugin/settings';
import { SyncApiClient } from './api';
import { WorkerApiHttpClient, type ApiHttpTransport } from './worker-api/http';
import { MAX_REQUEST_DIAGNOSTICS } from './request-diagnostics';
import { SyncEngine } from './engine';
import { runPeriodicCheck } from './engine-test-harness';

const requestId = 'e9ffeb0c-7610-4cdb-a129-913c45c2a053';
const sensitive = 'private-client-name-and-secret';
const response = (status = 200) => ({ status, headers: { 'X-Crate-Request-Id': requestId, 'Set-Cookie': sensitive }, text: JSON.stringify({ ok: true, private: sensitive }), arrayBuffer: new ArrayBuffer(0) });
beforeEach(() => vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('safe diagnostic export', () => {
	it('correlates actual outgoing IDs and responses, whitelists fields and bounds storage', async () => {
		const transport = vi.fn<ApiHttpTransport>(async () => response());
		const client = new WorkerApiHttpClient(`https://${sensitive}.example`, sensitive, transport);
		await client.requestJson(`/sync/download?path=${sensitive}.md`);
		const requests = client.getRequestDiagnostics();
		expect(requests.clientSession).toBe(transport.mock.calls[0]![0].headers!['X-Crate-Client-Session']);
		expect(requests.requests[0]).toMatchObject({ operationId: transport.mock.calls[0]![0].headers!['X-Crate-Operation-Id'], requestId, route: '/sync/download', status: 200, outcome: 'response' });
		for (let i = 0; i < MAX_REQUEST_DIAGNOSTICS; i++) await client.requestJson('/health');
		expect(client.getRequestDiagnostics().requests).toHaveLength(MAX_REQUEST_DIAGNOSTICS);
		expect(JSON.stringify(client.getRequestDiagnostics())).not.toContain(sensitive);
	});

	it('records failed/HTTP-error attempts without exporting error bodies or headers', async () => {
		const transport = vi.fn<ApiHttpTransport>().mockRejectedValueOnce(new Error(sensitive)).mockResolvedValueOnce(response(503));
		const client = new WorkerApiHttpClient('https://worker.example', sensitive, transport);
		await expect(client.requestJson('/health')).rejects.toThrow();
		await expect(client.requestJson('/health')).rejects.toThrow();
		expect(client.getRequestDiagnostics().requests.map(({ status, outcome }) => ({ status, outcome }))).toEqual([{ status: 0, outcome: 'failed' }, { status: 503, outcome: 'response' }]);
		expect(JSON.stringify(client.getRequestDiagnostics())).not.toContain(sensitive);
	});

	it('persists safe correlation through settings reload while excluding local history details from export', async () => {
		const h = createRuntimeHarness({ syncOnStartup: false });
		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue();
		await h.runtime.initialize({ skipStartupSync: true });
		const client = h.runtime.getApiClient()!;
		const source = new WorkerApiHttpClient('https://worker.example', sensitive, async () => response());
		await source.requestJson('/sync/check');
		vi.spyOn(client, 'getRequestDiagnostics').mockReturnValue(source.getRequestDiagnostics());
		vi.spyOn(client, 'getManifest').mockRejectedValue(new Error(`${sensitive}.md: ${sensitive}`));
		await h.runtime.verifyAllFiles();
		const settings = normalizeCrateSettings(h.settings, '.obsidian');
		expect(settings.syncHistory[0]?.requestDiagnostics?.requests[0]?.requestId).toBe(requestId);
		const report = buildDiagnosticExport(settings, h.runtime.getState(), '0.1.0');
		expect(report).toContain(requestId);
		expect(report).not.toContain(sensitive);
		expect(JSON.parse(report)).toMatchObject({ history: [{ success: false, errors: 1 }] });
		h.runtime.destroy();
	});

	it('rejects arbitrary strings smuggled into persisted correlation fields', () => {
		const h = createRuntimeHarness();
		const value = { clientSession: requestId, requests: [{ at: new Date().toISOString(), operationId: requestId, method: 'GET', route: `/sync/${sensitive}`, status: 200, outcome: 'response', requestId: sensitive, headers: sensitive }] };
		const report = buildDiagnosticExport(h.settings, h.runtime.getState(), '0.1.0', value as never);
		expect(report).not.toContain(sensitive);
		expect(JSON.parse(report)).toMatchObject({ requests: { requests: [{ route: 'other' }] } });
	});
});

describe('periodic sync activity', () => {
	it.each([true, false])('records a periodic result once and persists it (success: %s)', async success => {
		const h = createRuntimeHarness({ syncOnStartup: false, lastSeq: 10 });
		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue();
		await h.runtime.initialize({ skipStartupSync: true });
		vi.spyOn(SyncApiClient.prototype, 'checkForChanges').mockResolvedValue({ hasChanges: true, lastSeq: 11 });
		const changes = vi.spyOn(SyncApiClient.prototype, 'getChanges').mockResolvedValue({ changes: [], hasMore: false, lastSeq: 11 });
		if (!success) changes.mockRejectedValue(new Error('temporary changelog failure'));
		vi.spyOn(SyncApiClient.prototype, 'getManifest').mockRejectedValue(new Error('temporary manifest failure'));
		const engine = (h.runtime as unknown as { syncEngine: SyncEngine }).syncEngine;
		await runPeriodicCheck(engine);
		expect(h.settings.syncHistory).toHaveLength(1);
		expect(h.settings.syncHistory[0]?.success).toBe(success);
		expect(h.persistSettings).toHaveBeenCalledOnce();
		h.runtime.destroy();
	});

	it('does not create history for an idle check', async () => {
		const h = createRuntimeHarness({ syncOnStartup: false });
		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue();
		await h.runtime.initialize({ skipStartupSync: true });
		vi.spyOn(SyncApiClient.prototype, 'checkForChanges').mockResolvedValue({ hasChanges: false, lastSeq: 0 });
		const engine = (h.runtime as unknown as { syncEngine: SyncEngine }).syncEngine;
		await runPeriodicCheck(engine);
		expect(h.settings.syncHistory).toEqual([]);
		expect(h.persistSettings).not.toHaveBeenCalled();
		h.runtime.destroy();
	});
});
