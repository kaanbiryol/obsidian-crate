import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { SERVICE_WORKER_JS } from './index';
import { PWA_ASSET_VERSION } from '../../../pwa/shell/version';

it('waits for explicit activation and retains assets for every live client version', async () => {
	const handlers = new Map<string, (event: Record<string, unknown>) => void>();
	const current = `crate-reminders-shell-${PWA_ASSET_VERSION}`;
	const shells = new Set([current, 'crate-reminders-shell-old', 'crate-reminders-shell-older', 'another-app']);
	let live = [{ id: 'one' }, { id: 'two' }];
	const skipWaiting = vi.fn().mockResolvedValue(undefined);
	const put = vi.fn().mockResolvedValue(undefined);
	new Script(SERVICE_WORKER_JS).runInNewContext({
		TextEncoder, TextDecoder, URL,
		self: { addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler), skipWaiting,
			location: { href: `https://crate.test/notifications/sw.js?v=${PWA_ASSET_VERSION}` },
			clients: { matchAll: async () => live, claim: async () => {} } },
		fetch: async () => ({ ok: true }),
		caches: { keys: async () => [...shells], delete: async (name: string) => shells.delete(name), open: async () => ({ put }) },
	});
	const event = async (type: string, args = {}) => {
		let pending: Promise<unknown> | undefined;
		handlers.get(type)!({ ...args, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
		await pending;
	};
	await event('install');
	expect(put.mock.calls.map(call => call[0] as string)).toContain('/notifications');
	expect(skipWaiting).not.toHaveBeenCalled();
	await event('message', { data: { type: 'CRATE_ACTIVATE_UPDATE' } }); expect(skipWaiting).toHaveBeenCalledOnce();
	await event('activate'); expect(shells.size).toBe(4);
	await event('message', { source: { id: 'one' }, data: { type: 'CRATE_CLIENT_VERSION', version: 'old' } }); expect(shells.size).toBe(4);
	await event('message', { source: { id: 'two' }, data: { type: 'CRATE_CLIENT_VERSION', version: 'older' } }); expect(shells.size).toBe(4);
	live = [{ id: 'one' }];
	await event('message', { source: { id: 'one' }, data: { type: 'CRATE_CLIENT_VERSION', version: PWA_ASSET_VERSION } });
	expect([...shells]).toEqual([current, 'another-app']);
});

function runtimeHarness() {
	const handlers = new Map<string, (event: Record<string, unknown>) => void>();
	const put = vi.fn(async (_request: RequestInfo | URL, _response: Response) => {});
	const matchShell = vi.fn().mockResolvedValue(undefined);
	const matchAsset = vi.fn().mockResolvedValue(undefined);
	const fetch = vi.fn(async (_request: RequestInfo | URL, _options?: RequestInit) => new Response('network'));
	const open = vi.fn(async () => ({ put, match: matchShell }));
	const showNotification = vi.fn().mockResolvedValue(undefined);
	const matchClients = vi.fn().mockResolvedValue([]);
	const openWindow = vi.fn().mockResolvedValue(null);
	const skipWaiting = vi.fn().mockResolvedValue(undefined);
	new Script(SERVICE_WORKER_JS).runInNewContext({
		TextEncoder, TextDecoder, URL, URLSearchParams, Response, Request, fetch,
		caches: { open, match: matchAsset },
		self: { addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler),
			location: { origin: 'https://crate.test', href: `https://crate.test/notifications/sw.js?v=${PWA_ASSET_VERSION}` }, skipWaiting,
			registration: { showNotification }, clients: { matchAll: matchClients, openWindow } },
	});
	async function dispatch(type: string, value: Record<string, unknown> = {}) {
		const work: Promise<unknown>[] = [];
		let response: Promise<Response> | undefined;
		handlers.get(type)!({ ...value, waitUntil: (promise: Promise<unknown>) => work.push(promise),
			respondWith: (promise: Promise<Response>) => { response = promise; } });
		const result = await response;
		await Promise.all(work);
		return result;
	}
	return { dispatch, put, matchShell, matchAsset, fetch, open, showNotification, matchClients, openWindow, skipWaiting };
}

it('prepares the complete shell and leaves a failed install waiting', async () => {
	const harness = runtimeHarness();
	await harness.dispatch('install');
	const urls = ['/notifications', ...['app.js', 'theme-bootstrap.js', 'crate-icon-192.png', 'crate-icon-512.png',
		'crate-mark-256.png', 'apple-touch-icon-180.png'].map(name => `/notifications/${name}?v=${PWA_ASSET_VERSION}`)];
	// Downloads start in order, four at a time, so they may finish in any order.
	expect(harness.fetch.mock.calls.map(call => call[0])).toEqual(urls);
	expect(harness.put.mock.calls.map(call => call[0] as string).sort()).toEqual([...urls].sort());
	expect(harness.open).toHaveBeenCalledWith(`crate-reminders-shell-${PWA_ASSET_VERSION}`);
	expect(harness.skipWaiting).not.toHaveBeenCalled();
	harness.fetch.mockClear(); harness.put.mockClear();
	harness.fetch.mockResolvedValueOnce(new Response('shell')).mockResolvedValueOnce(new Response('', { status: 503 }));
	await expect(harness.dispatch('install')).rejects.toThrow('Offline asset unavailable');
	// A failure stops new downloads; only the four already in flight ran.
	expect(harness.fetch).toHaveBeenCalledTimes(4);
	expect(harness.put.mock.calls.map(call => call[0])).not.toContain(urls[1]);
	expect(harness.skipWaiting).not.toHaveBeenCalled();
});

it('serves the cached shell offline and never saves enrollment query responses', async () => {
	const harness = runtimeHarness();
	harness.matchShell.mockResolvedValueOnce(new Response('offline shell'));
	const cached = await harness.dispatch('fetch', { request: new Request('https://crate.test/notifications?project=Work') });
	expect(await cached!.text()).toBe('offline shell');
	expect(harness.fetch).not.toHaveBeenCalled();
	await harness.dispatch('fetch', { request: new Request('https://crate.test/notifications?token=private') });
	expect(harness.put).not.toHaveBeenCalled();
	await harness.dispatch('fetch', { request: new Request('https://crate.test/notifications') });
	expect(harness.put).toHaveBeenCalledExactlyOnceWith('/notifications', expect.any(Response));
});

it.each(['app.js', 'assets/old-editor.js', 'theme-bootstrap.js', 'icon.svg', 'crate-icon-192.png',
	'crate-icon-512.png', 'crate-mark-256.png', 'apple-touch-icon-180.png'])('uses retained cache entries for %s before requesting the network', async asset => {
	const harness = runtimeHarness();
	harness.matchAsset.mockResolvedValueOnce(new Response('old version'));
	const request = new Request(`https://crate.test/notifications/${asset}?v=old`);
	expect(await (await harness.dispatch('fetch', { request }))!.text()).toBe('old version');
	expect(harness.fetch).not.toHaveBeenCalled();
	await harness.dispatch('fetch', { request });
	expect(harness.put).toHaveBeenCalledExactlyOnceWith(request, expect.any(Response));
});

it.each(['/notifications/open-obsidian?project=Work', '/notifications/version.json', '/notifications/subscribe',
	'/reminders/list', 'https://other.test/notifications'])('leaves %s outside shell caching', async path => {
	const harness = runtimeHarness();
	expect(await harness.dispatch('fetch', { request: new Request(new URL(path, 'https://crate.test')) })).toBeUndefined();
	expect(harness.fetch).not.toHaveBeenCalled();
	expect(harness.open).not.toHaveBeenCalled();
});

it.each(['declarative', 'legacy'] as const)('preserves %s push display and navigation', async kind => {
	const harness = runtimeHarness();
	const notification = { title: 'Call Sam', body: 'Project follow-up', navigate: 'https://crate.test/notifications?reminderId=one',
		data: { project: 'Work', reminderId: 'one' } };
	await harness.dispatch('push', kind === 'declarative' ? { data: null, notification: Object.create(notification) as unknown }
		: { data: { json: () => ({ notification }) } });
	expect(harness.showNotification).toHaveBeenCalledExactlyOnceWith('Call Sam', expect.objectContaining({
		body: 'Project follow-up', navigate: notification.navigate,
		data: { project: 'Work', reminderId: 'one', navigate: notification.navigate },
	}));
});

it('focuses an existing app for reminder deep links and opens a window when none exists', async () => {
	const harness = runtimeHarness();
	const focus = vi.fn().mockResolvedValue(null), navigate = vi.fn().mockResolvedValue(null);
	const close = vi.fn();
	harness.matchClients.mockResolvedValueOnce([{ url: 'https://crate.test/other' }, { url: 'https://crate.test/notifications', focus, navigate }]);
	await harness.dispatch('notificationclick', { notification: { close, data: { project: 'Work', reminderId: 'one' } } });
	expect(close).toHaveBeenCalledOnce();
	expect(navigate).toHaveBeenCalledExactlyOnceWith('/notifications?project=Work&reminderId=one');
	expect(focus).toHaveBeenCalledOnce();
	expect(harness.openWindow).not.toHaveBeenCalled();
	await harness.dispatch('notificationclick', { notification: { close, data: { navigate: 'https://crate.test/notifications?reminderId=two' } } });
	expect(harness.openWindow).toHaveBeenCalledExactlyOnceWith('https://crate.test/notifications?reminderId=two');
});
