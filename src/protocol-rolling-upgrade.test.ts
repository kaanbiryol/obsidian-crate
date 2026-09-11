import { afterEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient } from './sync/worker-api/http';
import { makeApiFetch } from './pwa/api';
import { DurableRestores } from './sync/durable-restores';

vi.mock('./pwa/session-label', () => ({ detectWebSessionName: () => 'Compatibility test' }));
// Frozen protocol-7 wire metadata: do not derive this fixture from current code.
const previousServer = { service: 'crate' as const, serverVersion: '0.1.0', protocol: { current: 7, oldestCompatible: 7 }, capabilities: ['sync-v1'], reminderOperationDay: 20707 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('the current plugin negotiates protocol 7 for an ordinary mutation on the previous server', async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	const transport = vi.fn(async (request: { url: string; headers?: Record<string, string> }) => {
		const text = JSON.stringify(request.url.endsWith('/.well-known/crate') ? previousServer : { success: true });
		return { status: 200, text, arrayBuffer: new TextEncoder().encode(text).buffer, headers: {} };
	});
	const client = new WorkerApiHttpClient('https://old.example', 'token', transport);
	await client.requestJson('/settings', { method: 'PUT', body: '{}', headers: { 'X-Crate-Upload-Operation': 'e1_00020707_saved-operation-id-123456' } });
	expect(transport.mock.calls[1]![0].headers?.['X-Crate-Protocol']).toBe('7');
	expect(client.getRequestDiagnostics().requests.at(-1)?.uploadOperationIds).toEqual(['e1_00020707_saved-operation-id-123456']);
});

it('the current PWA negotiates protocol 7 without altering a saved operation body', async () => {
	vi.stubGlobal('localStorage', { getItem: () => 'token' });
	const network = vi.fn(async (path: string, _init?: RequestInit) => Response.json(path === '/.well-known/crate' ? previousServer : { success: true }));
	vi.stubGlobal('fetch', network);
	const body = JSON.stringify({ operationId: 'e1_00020707_00000000-0000-4000-8000-000000000001', id: 'e1_00020707_00000000-0000-4000-8000-000000000001', folderPath: 'Reminders', content: 'Saved offline' });
	await makeApiFetch('token', vi.fn())('/reminders/create', { method: 'POST', body });
	const init = network.mock.calls[1]![1];
	expect(new Headers(init?.headers).get('X-Crate-Protocol')).toBe('7');
	expect(init?.body).toBe(body);
});

it('refuses unsafe restore on the previous server before reading a new precondition or dispatching', async () => {
	const transport = { getServerInfo: async () => previousServer, getFileMetadata: vi.fn(), restoreFileVersion: vi.fn() };
	const manifest = { getRestoreIntents: () => [] };
	const journal = new DurableRestores(manifest as never, transport);
	await expect(journal.restore({ storage_key: 'retained' } as never)).rejects.toThrow('Update the Crate server');
	expect(transport.getFileMetadata).not.toHaveBeenCalled();
	expect(transport.restoreFileVersion).not.toHaveBeenCalled();
});
