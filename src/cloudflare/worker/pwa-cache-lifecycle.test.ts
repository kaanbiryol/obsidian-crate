import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { SERVICE_WORKER_JS } from './pwa';
import { PWA_ASSET_VERSION } from './pwa-version';

it('waits for explicit activation and retains assets for every live client version', async () => {
	const handlers = new Map<string, (event: Record<string, unknown>) => void>();
	const current = `crate-reminders-shell-${PWA_ASSET_VERSION}`;
	const shells = new Set([current, 'crate-reminders-shell-old', 'crate-reminders-shell-older']);
	let live = [{ id: 'one' }, { id: 'two' }];
	const skipWaiting = vi.fn().mockResolvedValue(undefined);
	const addAll = vi.fn().mockResolvedValue(undefined);
	new Script(SERVICE_WORKER_JS).runInNewContext({
		self: { addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler), skipWaiting,
			clients: { matchAll: async () => live, claim: async () => {} } },
		caches: { keys: async () => [...shells], delete: async (name: string) => shells.delete(name), open: async () => ({ addAll }) },
	});
	const event = async (type: string, args = {}) => {
		let pending: Promise<unknown> | undefined;
		handlers.get(type)!({ ...args, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
		await pending;
	};
	await event('install'); expect(addAll).toHaveBeenCalledOnce(); expect(skipWaiting).not.toHaveBeenCalled();
	await event('message', { data: { type: 'CRATE_ACTIVATE_UPDATE' } }); expect(skipWaiting).toHaveBeenCalledOnce();
	await event('activate'); expect(shells.size).toBe(3);
	await event('message', { source: { id: 'one' }, data: { type: 'CRATE_CLIENT_VERSION', version: 'old' } }); expect(shells.size).toBe(3);
	await event('message', { source: { id: 'two' }, data: { type: 'CRATE_CLIENT_VERSION', version: 'older' } }); expect(shells.size).toBe(3);
	live = [{ id: 'one' }];
	await event('message', { source: { id: 'one' }, data: { type: 'CRATE_CLIENT_VERSION', version: PWA_ASSET_VERSION } });
	expect([...shells]).toEqual([current]);
});
