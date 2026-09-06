import type CratePlugin from './CratePlugin';

const lifetimes = new WeakMap<CratePlugin, AbortController>();

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
