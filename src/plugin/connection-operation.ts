import type CratePlugin from './CratePlugin';

/** The flows that change which server this vault uses. */
export type ConnectionOperation = 'self-hosted' | 'cloudflare' | 'pairing';

const running = new WeakMap<CratePlugin, ConnectionOperation>();

/** The connection flow running for this plugin, if any. One runs at a time, so none
 * writes settings or credentials over another's. The deployment service's own busy
 * state and saved intent still guard its OAuth round trip. */
export function runningConnectionOperation(plugin: CratePlugin): ConnectionOperation | undefined {
	return running.get(plugin);
}

/** Claims the connection slot. Returns its release, or null while another flow holds it. */
export function beginConnectionOperation(plugin: CratePlugin, operation: ConnectionOperation): (() => void) | null {
	if (running.has(plugin)) return null;
	running.set(plugin, operation);
	return () => { if (running.get(plugin) === operation) running.delete(plugin); };
}
