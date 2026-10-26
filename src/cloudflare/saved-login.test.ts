import { expect, it, vi } from 'vitest';
import { CloudflareSavedLogin } from './saved-login';
import { CLOUDFLARE_ANALYTICS_SCOPE as USAGE_SCOPE, CLOUDFLARE_OAUTH_SCOPES } from './oauth/config';
import type { UsageSnapshot } from './usage/snapshot';
import type { HttpTransport } from './http';

function setup() {
	let time = 1_000_000;
	let snapshot: UsageSnapshot | null = null;
	let account = 'account-a';
	const abort = new AbortController();
	const values = new Map<string, string>();
	const transport = vi.fn<HttpTransport>(async url => {
		if (url.endsWith('/token')) return { status: 200, text: JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: [...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' ') }) };
		if (url.endsWith('/revoke')) return { status: 200, text: '{}' };
		return { status: 200, text: JSON.stringify({ data: { viewer: { accounts: [{ accountTag: account, usage: [] }] } } }) };
	});
	const connection = new CloudflareSavedLogin({
		cache: { read: () => snapshot, write: async value => { snapshot = value; } },
		clientId: 'client', transport, signal: abort.signal,
		accountId: () => account, now: () => time,
		secrets: { get: key => values.get(key), set: (key, value) => { values.set(key, value); } },
	});
	const connect = () => connection.acceptAuthorization(account, { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, scope: [...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' ') });
	return { connection, transport, connect, values, advance: (ms: number) => { time += ms; }, switchAccount: () => { account = 'account-b'; } };
}

it('refuses unrelated grants without storing them', () => {
	const h = setup();
	expect(() => h.connection.acceptAuthorization('account-a', { accessToken: 'broad', scope: `${USAGE_SCOPE} dns.write` })).toThrow('unexpected permissions');
	expect(h.values.size).toBe(0);
	expect(h.connection.connected).toBe(false);
});

it('renews only on refresh and persists a rotated refresh token', async () => {
	const h = setup(); h.connect(); h.advance(3_600_000);
	expect(h.transport).not.toHaveBeenCalled();
	h.transport.mockResolvedValueOnce({ status: 200, text: '{"access_token":"renewed","refresh_token":"rotated","expires_in":3600}' });
	await h.connection.fetchUsage();
	expect(h.transport.mock.calls[0]?.[1]?.body).toContain('grant_type=refresh_token');
	expect(h.values.get('crate-usage-oauth-account-a')).toContain('rotated');
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

it('revokes both saved tokens and disconnects when the login is forgotten', async () => {
	const h = setup();
	h.connection.acceptAuthorization('account-a', { accessToken: 'saved-access', refreshToken: 'saved-refresh', expiresIn: 3600 });
	await h.connection.forget('account-a');
	expect(h.transport.mock.calls.map(([url, request]) => [new URL(url).pathname, new URLSearchParams(request?.body as string).get('token')]))
		.toEqual([['/oauth2/revoke', 'saved-access'], ['/oauth2/revoke', 'saved-refresh']]);
	expect(h.values.get('crate-usage-oauth-account-a')).toBe('');
	expect(h.connection.connected).toBe(false);
});

it('keeps saved results when a later refresh fails and isolates them by account', async () => {
	const h = setup(); h.connect();
	await h.connection.fetchUsage();
	const saved = h.connection.snapshot;
	expect(saved?.accountId).toBe('account-a');
	h.transport.mockResolvedValue({ status: 503, text: '{}' });
	await expect(h.connection.fetchUsage()).rejects.toThrow('last saved data');
	expect(h.connection.snapshot).toBe(saved);
	h.switchAccount();
	expect(h.connection.snapshot).toBeNull();
});

it('exposes current unknown operation details even when retaining a saved snapshot', async () => {
	const h = setup(); h.connect();
	await h.connection.fetchUsage();
	const saved = h.connection.snapshot;
	h.transport.mockResolvedValue({ status: 200, text: JSON.stringify({ data: { viewer: { accounts: [{ usage: [
		{ dimensions: { actionType: 'NewAction' }, sum: { requests: 12, rowsRead: 0, rowsWritten: 0 }, max: { databaseSizeBytes: 1, payloadSize: 1, metadataSize: 0 } },
	] }] } } }) });
	await expect(h.connection.fetchUsage()).rejects.toThrow('unrecognized operations (NewAction: 12)');
	expect(h.connection.snapshot).toBe(saved);
});

it('exposes service failures when no saved snapshot exists', async () => {
	const h = setup(); h.connect();
	h.transport.mockResolvedValue({ status: 503, text: '{}' });
	await expect(h.connection.fetchUsage()).rejects.toThrow('HTTP 503');
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

it('renews a saved login with under 10 minutes left before a long operation starts', async () => {
	const h = setup();
	h.connection.acceptAuthorization('account-a', { accessToken: 'old', refreshToken: 'refresh', expiresIn: 3600 });
	h.advance(2_999_000);
	const operation = vi.fn(async () => 'done');
	await h.connection.withAuthorization(operation);
	expect(h.transport).not.toHaveBeenCalled();
	expect(operation).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'old' }));
	h.advance(2000);
	await h.connection.withAuthorization(operation);
	expect(h.transport.mock.calls[0]?.[1]?.body).toContain('grant_type=refresh_token');
	expect(operation).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'access' }));
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
