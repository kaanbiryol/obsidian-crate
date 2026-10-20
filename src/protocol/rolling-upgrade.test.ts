import { afterEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient } from '../sync/worker-api/http';

// Frozen launch protocol-1 wire metadata: do not derive this fixture from current code.
const baselineServer = { service: 'crate' as const, serverVersion: '0.1.0', protocol: { current: 1, oldestCompatible: 1 }, capabilities: ['sync-v1'], reminderOperationDay: 20707 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('the current plugin negotiates protocol 1 for an ordinary mutation on the baseline server', async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	const transport = vi.fn(async (request: { url: string; headers?: Record<string, string> }) => {
		const text = JSON.stringify(request.url.endsWith('/.well-known/crate') ? baselineServer : { success: true });
		return { status: 200, text, arrayBuffer: new TextEncoder().encode(text).buffer, headers: {} };
	});
	const client = new WorkerApiHttpClient('https://old.example', 'token', transport);
	await client.requestJson('/settings', { method: 'PUT', body: '{}', headers: { 'X-Crate-Upload-Operation': 'e1_00020707_saved-operation-id-123456' } });
	expect(transport.mock.calls[1]![0].headers?.['X-Crate-Protocol']).toBe('1');
	expect(client.getRequestDiagnostics().requests.at(-1)?.uploadOperationIds).toEqual(['e1_00020707_saved-operation-id-123456']);
});
