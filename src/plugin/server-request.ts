import type CratePlugin from './CratePlugin';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { SECRET_KEYS } from './settings-types';
import { obsidianHttpTransport, WorkerApiHttpClient } from '../sync/worker-api/http';

interface ServerRequestOptions {
	timeout?: number;
	/** Capability names and the instructions shown when the server lacks them. */
	capabilities?: Readonly<Record<string, string>>;
}

/** Bind every request in a feature operation to the plugin's original connection. */
export async function serverRequest<T>(
	plugin: CratePlugin,
	path: string,
	body?: unknown,
	{ timeout = 30_000, capabilities = {} }: ServerRequestOptions = {},
): Promise<T> {
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	const origin = plugin.settings.workerUrl;
	const token = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
	if (!origin || !token) throw new Error('Connect Crate to your server first.');
	const assertCurrent = () => {
		signal.throwIfAborted();
		if (plugin.settings.workerUrl !== origin || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== token) {
			throw new DOMException('The server connection changed. Reopen settings and try again.', 'AbortError');
		}
	};
	const client = new WorkerApiHttpClient(origin, token, async request => {
		assertCurrent();
		try { return await obsidianHttpTransport(request); }
		finally { assertCurrent(); }
	});
	client.setAbortSignal(signal);
	const info = await client.getServerInfo(timeout);
	assertCurrent();
	for (const [capability, message] of Object.entries(capabilities)) {
		if (!info.capabilities.includes(capability)) throw new Error(message);
	}
	const result = await client.requestJson<T>(path, body === undefined ? undefined : {
		method: 'POST', body: JSON.stringify(body),
	}, timeout);
	assertCurrent();
	return result;
}
