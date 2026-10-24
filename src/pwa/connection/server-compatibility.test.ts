import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
import { requireCompatibleProtocol, requireCompatibleServer } from './server-compatibility';

const info = { service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: 20_000 };
const fetchMock = vi.fn(async () => Response.json(info));

// Each test starts a minute later, so a result shared by the previous test has expired.
let now = performance.now();
beforeEach(() => {
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	now += 60_000;
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fetchMock.mockClear(); });

it('reads server info once for a save operation id and its protocol header', async () => {
	expect((await requireCompatibleServer()).reminderOperationDay).toBe(20_000);
	expect(await requireCompatibleProtocol()).toBe(CRATE_PLUGIN_PROTOCOL.current);
	// Before: each read sent its own request, adding a serial round trip per save.
	expect(fetchMock).toHaveBeenCalledOnce();
	// A later save checks the server again.
	now += 5_000;
	await requireCompatibleServer();
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('retries at once after a failed read', async () => {
	fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
	await expect(requireCompatibleServer()).rejects.toThrow('Update the Crate server');
	await requireCompatibleServer();
	expect(fetchMock).toHaveBeenCalledTimes(2);
});
