import { expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { build } from 'esbuild';

// The worker runtime uses service worker types, so it is compiled like the push test.
const runtime = await build({
	entryPoints: [new URL('./service-worker/runtime.ts', import.meta.url).pathname],
	bundle: true, write: false, format: 'iife', globalName: 'crateServiceWorker', platform: 'browser', target: 'es2022',
});
const serverKey = new Uint8Array([4, 1, 2, 3]).buffer;
const changed = { type: 'CRATE_PUSH_SUBSCRIPTION_CHANGED' };

/** Dispatches one subscription change and resolves once the worker's work settles. */
async function subscriptionChange(event: { oldSubscription: unknown; newSubscription: unknown }, subscribe = vi.fn(async () => ({}))) {
	const handlers = new Map<string, (event: unknown) => void>();
	const page = { postMessage: vi.fn() };
	const matchAll = vi.fn(async () => [page]);
	new Script(`${runtime.outputFiles[0]!.text}\ncrateServiceWorker.initialize(self, { version: 'test', chunkUrls: [] });`).runInNewContext({
		self: { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
			registration: { pushManager: { subscribe } }, clients: { matchAll } },
		URL, TextEncoder, TextDecoder,
	});
	let work!: Promise<unknown>;
	handlers.get('pushsubscriptionchange')!({ ...event, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
	await work;
	return { subscribe, page, matchAll };
}

it('renews a replaced subscription with its server key and asks open pages to register it', async () => {
	const { subscribe, page, matchAll } = await subscriptionChange({ oldSubscription: { options: { applicationServerKey: serverKey } }, newSubscription: null });
	expect(subscribe).toHaveBeenCalledExactlyOnceWith({ userVisibleOnly: true, applicationServerKey: serverKey });
	expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
	expect(page.postMessage).toHaveBeenCalledExactlyOnceWith(changed);
});

it.each([
	['the browser already renewed it', { oldSubscription: { options: { applicationServerKey: serverKey } }, newSubscription: {} }],
	['its server key is unknown', { oldSubscription: null, newSubscription: null }],
])('does not subscribe when %s, but still asks open pages to confirm', async (_reason, event) => {
	const { subscribe, page } = await subscriptionChange(event);
	expect(subscribe).not.toHaveBeenCalled();
	expect(page.postMessage).toHaveBeenCalledExactlyOnceWith(changed);
});

it('asks open pages to confirm when the browser refuses a renewal', async () => {
	const { page } = await subscriptionChange({ oldSubscription: { options: { applicationServerKey: serverKey } }, newSubscription: null },
		vi.fn(async () => { throw new Error('Permission denied'); }));
	expect(page.postMessage).toHaveBeenCalledExactlyOnceWith(changed);
});
