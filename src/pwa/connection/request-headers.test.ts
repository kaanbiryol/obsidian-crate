import { beforeEach, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
import { forgetCompatibleProtocol, requireCompatibleProtocol } from './server-compatibility';
import { crateProtocol, crateRequestHeaders, forgetRefusedProtocol } from './request-headers';

vi.mock('./server-compatibility', () => ({ requireCompatibleProtocol: vi.fn(), forgetCompatibleProtocol: vi.fn() }));

beforeEach(() => {
	vi.mocked(requireCompatibleProtocol).mockReset().mockResolvedValue(7);
	vi.mocked(forgetCompatibleProtocol).mockReset();
});

it('sends the negotiated protocol for a change and the client protocol for a read', async () => {
	expect(await crateProtocol('/reading/update', 'POST')).toBe(7);
	expect(await crateProtocol('/encryption/pairing', 'POST')).toBe(7);
	expect(await crateProtocol('/auth/session', 'DELETE')).toBe(7);
	expect(await crateProtocol('/reading/items')).toBe(CRATE_PLUGIN_PROTOCOL.current);
	expect(await crateProtocol('/links/title', 'POST')).toBe(CRATE_PLUGIN_PROTOCOL.current);
	expect(requireCompatibleProtocol).toHaveBeenCalledTimes(3);
	expect(crateRequestHeaders('token', 7)).toEqual({ Authorization: 'Bearer token', 'X-Crate-Protocol': '7' });
});

it('forgets the negotiated protocol only when the server refuses it', async () => {
	await forgetRefusedProtocol(Response.json({ error: 'Busy', code: 'locked' }, { status: 428 }));
	await forgetRefusedProtocol(Response.json({ ok: true }));
	expect(forgetCompatibleProtocol).not.toHaveBeenCalled();
	await forgetRefusedProtocol(Response.json({ error: 'Update', code: 'protocol_incompatible' }, { status: 428 }));
	expect(forgetCompatibleProtocol).toHaveBeenCalledOnce();
});
