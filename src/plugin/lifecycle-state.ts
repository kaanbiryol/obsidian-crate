import type CratePlugin from './CratePlugin';

const lifetimes = new WeakMap<CratePlugin, AbortController>();
const syncReadiness = new WeakMap<CratePlugin, Promise<void>>();

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
	getPluginLifecycleSignal(plugin);
	lifetimes.get(plugin)!.abort();
}

export function setSyncReady(plugin: CratePlugin, ready: Promise<void>): void {
	syncReadiness.set(plugin, ready);
}

/** Settles once startup sync initialization has finished or was skipped. */
export function waitForSyncReady(plugin: CratePlugin): Promise<void> {
	return syncReadiness.get(plugin) ?? Promise.resolve();
}
