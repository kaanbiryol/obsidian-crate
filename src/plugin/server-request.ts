import { loadEncryptionKeys } from '../sync/encryption/key-storage';
import type CratePlugin from './CratePlugin';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { obsidianHttpTransport, WorkerApiHttpClient } from '../sync/worker-api/http';
import { SECRET_KEYS } from '../platform/secret-keys';

interface ServerRequestOptions {
	timeout?: number;
	/** Capability names and the instructions shown when the server lacks them. */
	capabilities?: Readonly<Record<string, string>>;
}

function connectionChanged(): DOMException {
	return new DOMException('The server connection changed. Reopen settings and try again.', 'AbortError');
}

/** Capture once for operations that span requests, queued saves and UI publication. */
export function captureServerConnection(plugin: CratePlugin) {
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	const origin = plugin.settings.workerUrl;
	const token = origin ? plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) : null;
	const assertCurrent = () => {
		signal.throwIfAborted();
		if (plugin.settings.workerUrl !== origin || origin && plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== token) {
			throw connectionChanged();
		}
	};
	return { signal, origin, token, assertCurrent };
}

/** Also captures the sync runtime's client, whose encryption keys map folder labels, so a
 * mapping and the request it accompanies cannot come from different connections. */
export function captureSyncApiConnection(plugin: CratePlugin) {
	const connection = captureServerConnection(plugin);
	const api = plugin.syncRuntime.getApiClient();
	const assertCurrent = () => {
		connection.assertCurrent();
		if (plugin.syncRuntime.getApiClient() !== api) throw connectionChanged();
	};
	return { ...connection, api, assertCurrent };
}

/** Bind request dispatch and response publication to the same connection. */
export async function serverRequest<T>(
	plugin: CratePlugin,
	path: string,
	body?: unknown,
	{ timeout = 30_000, capabilities = {} }: ServerRequestOptions = {},
): Promise<T> {
	const { signal, origin, token, assertCurrent } = captureServerConnection(plugin);
	if (!origin || !token) throw new Error('Connect Crate to your server first.');
	const client = new WorkerApiHttpClient(origin, token, async request => {
		assertCurrent();
		try { return await obsidianHttpTransport(request); }
		finally { assertCurrent(); }
	});
	client.setAbortSignal(signal);
	const keys = loadEncryptionKeys(plugin.secretStorage);
	if (keys) client.setEncryptionAuthority(keys.vaultId, keys.generation);
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
