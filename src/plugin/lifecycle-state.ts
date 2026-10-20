import type CratePlugin from './CratePlugin';

// Keyed by instance so a reloaded plugin never sees its predecessor's state.
const lifetimes = new WeakMap<CratePlugin, AbortController>();
const syncReadiness = new WeakMap<CratePlugin, Promise<void>>();

/** Work that starts before onload begins a lifecycle gets a provisional signal,
 * which the next beginPluginLifecycle aborts because that lifecycle did not start it. */
export function getPluginLifecycleSignal(plugin: CratePlugin): AbortSignal {
	let controller = lifetimes.get(plugin);
	if (!controller) {
		controller = new AbortController();
		lifetimes.set(plugin, controller);
	}
	return controller.signal;
}

export function beginPluginLifecycle(plugin: CratePlugin): AbortSignal {
	lifetimes.get(plugin)?.abort();
	const controller = new AbortController();
	lifetimes.set(plugin, controller);
	return controller.signal;
}

export function endPluginLifecycle(plugin: CratePlugin): void {
	// Later lookups must see an ended lifecycle even if none was begun.
	const controller = lifetimes.get(plugin) ?? new AbortController();
	controller.abort();
	lifetimes.set(plugin, controller);
}

export function setSyncReady(plugin: CratePlugin, ready: Promise<void>): void {
	syncReadiness.set(plugin, ready);
}

/** Settles once startup sync initialization has finished or was skipped. */
export function waitForSyncReady(plugin: CratePlugin): Promise<void> {
	return syncReadiness.get(plugin) ?? Promise.resolve();
}
