import { expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { build } from 'esbuild';

// The worker runtime uses service worker types, so it is compiled like the push test.
const runtime = await build({
	entryPoints: [new URL('./service-worker/runtime.ts', import.meta.url).pathname],
	bundle: true, write: false, format: 'iife', globalName: 'crateServiceWorker', platform: 'browser', target: 'es2022',
});

const chunks = Array.from({ length: 74 }, (_, index) => `/notifications/assets/chunk-${index.toString(36).padStart(8, 'A')}.js`);

/** Runs one install against in-memory caches holding `previous` from an earlier version. */
async function install(chunkUrls: string[], previous: string[], failing?: string, scriptVersion = 'v2') {
	const stores = new Map<string, Map<string, Response>>([['crate-reminders-shell-v1', new Map(previous.map(url => [url, new Response(url)]))]]);
	let inFlight = 0, peak = 0;
	const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
		inFlight += 1; peak = Math.max(peak, inFlight);
		await new Promise(resolve => setTimeout(resolve, 1));
		inFlight -= 1;
		return new Response(url, { status: url === failing ? 503 : 200 });
	});
	const caches = {
		open: async (name: string) => {
			const store = stores.get(name) ?? new Map<string, Response>();
			stores.set(name, store);
			return { put: async (url: string, response: Response) => { store.set(url, response); } };
		},
		match: async (url: string) => [...stores.values()].find(store => store.has(url))?.get(url),
	};
	const handlers = new Map<string, (event: unknown) => void>();
	new Script(`${runtime.outputFiles[0]!.text}\ncrateServiceWorker.initialize(self, config);`).runInNewContext({
		self: { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
			location: { href: `https://crate.example/notifications/sw.js?v=${scriptVersion}` } },
		config: { version: 'v2', chunkUrls }, fetch, caches, Response, URL, setTimeout, TextEncoder, TextDecoder,
	});
	let work!: Promise<unknown>;
	handlers.get('install')!({ waitUntil: (promise: Promise<unknown>) => { work = promise; } });
	const result = await work.then(() => 'installed', (error: Error) => error.message);
	return { result, fetched: fetch.mock.calls.map(([url]) => url), init: new Map(fetch.mock.calls.map(([url, options]) => [url, options] as const)), peak, cached: stores.get('crate-reminders-shell-v2')! };
}

it('reuses unchanged hashed chunks from an earlier version and downloads the rest in parallel', async () => {
	const changed = ['/notifications/assets/chunk-NEW00001.js', '/notifications/assets/chunk-NEW00002.js'];
	const { result, fetched, peak, cached } = await install([...chunks.slice(2), ...changed], chunks);
	expect(result).toBe('installed');
	// Before: all 81 files, one at a time. Versioned files always come from the network.
	expect(fetched).toHaveLength(9);
	expect(fetched.filter(url => url.includes('chunk-'))).toEqual(changed);
	expect(peak).toBe(4);
	expect(cached.size).toBe(81);
});

it('still fails the install when any asset is unavailable', async () => {
	const { result } = await install(chunks, [], chunks[10]);
	expect(result).toBe(`Offline asset unavailable: ${chunks[10]}`);
});

it('bypasses the HTTP cache only for the unversioned shell', async () => {
	// The page already loaded immutable hashed and versioned assets before registering.
	const { init } = await install(chunks.slice(0, 2), []);
	expect(init.get('/notifications')).toEqual({ cache: 'reload' });
	expect([...init].filter(([url, options]) => url !== '/notifications' && options !== undefined)).toEqual([]);
	expect(init.size).toBe(9);
});

it('refuses to install a version its registration did not request', async () => {
	const { result, fetched, cached } = await install(chunks, [], undefined, 'v1');
	expect(result).toBe('This app version was not requested by the update flow.');
	expect(fetched).toEqual([]);
	expect(cached).toBeUndefined();
});
