import { describe, expect, it, vi } from 'vitest';
import { CloudflareUsageConnection } from './usage-connection';
import { CLOUDFLARE_ANALYTICS_SCOPE as USAGE_SCOPE, CLOUDFLARE_OAUTH_SCOPES } from './oauth-config';
import type { UsageSnapshot } from './usage-snapshot';
import type { HttpTransport } from './http';

function setup() {
	let time = 1_000_000;
	let snapshot: UsageSnapshot | null = null;
	let account = 'account-a';
	const abort = new AbortController();
	const values = new Map<string, string>();
	const openExternal = vi.fn();
	const transport = vi.fn<HttpTransport>(async url => {
		if (url.endsWith('/token')) return { status: 200, text: JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: [...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' ') }) };
		if (url.endsWith('/revoke')) return { status: 200, text: '{}' };
		return { status: 200, text: JSON.stringify({ data: { viewer: { accounts: [{ accountTag: account, usage: [] }] } } }) };
	});
	const connection = new CloudflareUsageConnection({
		cache: { read: () => snapshot, write: async value => { snapshot = value; } },
		clientId: 'client', transport, openExternal, signal: abort.signal,
		accountId: () => account, now: () => time,
		secrets: { get: key => values.get(key), set: (key, value) => { values.set(key, value); } },
	});
	async function start() {
		await connection.connect();
		return new URL(openExternal.mock.lastCall![0] as string);
	}
	async function connect() { const url = await start(); await connection.handleCallback({ state: url.searchParams.get('state')!, code: 'code' }); }
	return { connection, transport, start, connect, values, abort, advance: (ms: number) => { time += ms; }, switchAccount: () => { account = 'account-b'; } };
}

describe('usage OAuth connection', () => {
	it('accepts all required deployment and analytics permissions with PKCE, validates the account and stores credentials separately', async () => {
		const h = setup();
		const url = await h.start();
		expect(url.searchParams.get('scope')).toBe([...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' '));
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		await h.connection.handleCallback({ state: url.searchParams.get('state')!, code: 'code' });
		expect(h.connection.connected).toBe(true);
		expect(h.values.has('crate-usage-oauth-account-a')).toBe(true);
		expect(h.transport.mock.calls[1]?.[1]?.body).toContain('account-a');
	});

	it('rejects mismatched state without exchanging a code', async () => {
		const h = setup(); await h.start();
		await expect(h.connection.handleCallback({ state: 'wrong', code: 'code' })).rejects.toThrow('did not match');
		expect(h.transport).not.toHaveBeenCalled();
	});

	it('rejects expired callbacks and account changes', async () => {
		const h = setup(); const url = await h.start(); h.advance(600_001);
		await expect(h.connection.handleCallback({ state: url.searchParams.get('state')!, code: 'code' })).rejects.toThrow('expired');
		const next = await h.start(); h.switchAccount();
		await expect(h.connection.handleCallback({ state: next.searchParams.get('state')!, code: 'code' })).rejects.toThrow('changed');
		expect(h.transport).not.toHaveBeenCalled();
	});

	it('revokes unrelated grants without storing them', async () => {
		const h = setup(); const url = await h.start();
		h.transport.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ access_token: 'broad', scope: `${USAGE_SCOPE} dns.write` }) });
		await expect(h.connection.handleCallback({ state: url.searchParams.get('state')!, code: 'code' })).rejects.toThrow('unexpected permissions');
		expect(h.values.size).toBe(0);
		expect(h.transport.mock.lastCall?.[0]).toContain('/revoke');
	});

	it('revokes a late exchange after unload without sending analytics requests', async () => {
		const h = setup(); const url = await h.start();
		h.transport.mockImplementationOnce(async () => { h.abort.abort(); return { status: 200, text: '{"access_token":"late"}' }; });
		await expect(h.connection.handleCallback({ state: url.searchParams.get('state')!, code: 'code' })).rejects.toThrow();
		expect(h.values.size).toBe(0);
		expect(h.transport.mock.calls.map(call => new URL(call[0]).pathname)).toEqual(['/oauth2/token', '/oauth2/revoke']);
	});

	it('renews only on refresh and persists a rotated refresh token', async () => {
		const h = setup(); await h.connect(); h.transport.mockClear(); h.advance(3_600_000);
		expect(h.transport).not.toHaveBeenCalled();
		h.transport.mockResolvedValueOnce({ status: 200, text: '{"access_token":"renewed","refresh_token":"rotated","expires_in":3600}' });
		await h.connection.fetchUsage();
		expect(h.transport.mock.calls[0]?.[1]?.body).toContain('grant_type=refresh_token');
		expect(h.values.get('crate-usage-oauth-account-a')).toContain('rotated');
	});
});

it('uses setup credentials without a second authorization and renews them on demand', async () => {
	const h = setup();
	h.connection.acceptAuthorization('account-a', { accessToken: 'setup', refreshToken: 'setup-refresh', expiresIn: 3600 });
	expect(h.connection.connected).toBe(true);
	expect(h.transport).not.toHaveBeenCalled();
	h.advance(3_600_000);
	await h.connection.fetchUsage();
	expect(h.transport.mock.calls[0]?.[1]?.body).toContain('refresh_token=setup-refresh');
});

it('keeps saved results when a later refresh fails and isolates them by account', async () => {
	const h = setup(); await h.connect();
	await h.connection.fetchUsage();
	const saved = h.connection.snapshot;
	expect(saved?.accountId).toBe('account-a');
	h.transport.mockResolvedValue({ status: 503, text: '{}' });
	await expect(h.connection.fetchUsage()).rejects.toThrow('last saved data');
	expect(h.connection.snapshot).toBe(saved);
	h.switchAccount();
	expect(h.connection.snapshot).toBeNull();
});

it('renews saved deployment access and preserves scopes when renewal omits them', async () => {
	const h = setup();
	h.connection.acceptAuthorization('account-a', { accessToken: 'old', refreshToken: 'refresh', expiresIn: 1, scope: CLOUDFLARE_OAUTH_SCOPES.join(' ') });
	h.advance(2000);
	h.transport.mockResolvedValueOnce({ status: 200, text: '{"access_token":"renewed","refresh_token":"rotated","expires_in":3600}' });
	const deploy = vi.fn(async () => 'updated');
	expect(await h.connection.withAuthorization(deploy)).toBe('updated');
	expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'renewed', scope: CLOUDFLARE_OAUTH_SCOPES.join(' ') }));
});

it.each([
	[400, '{"error":"invalid_grant"}', 'Reconnect Cloudflare'],
	[503, '{}', 'unavailable'],
])('handles renewal failure %s before deployment', async (status, text, message) => {
	const h = setup();
	h.connection.acceptAuthorization('account-a', { accessToken: 'old', refreshToken: 'refresh', expiresIn: 1 });
	h.advance(2000);
	h.transport.mockResolvedValueOnce({ status, text });
	const deploy = vi.fn(async () => 'updated');
	await expect(h.connection.withAuthorization(deploy)).rejects.toThrow(message);
	expect(deploy).not.toHaveBeenCalled();
	expect(h.connection.needsAuthorization).toBe(status === 400);
});
