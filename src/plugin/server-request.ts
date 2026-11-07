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

/** The plugin's server address and credentials; `syncRuntime` adds its sync client. */
type ServerConnectionHost = Pick<CratePlugin, 'settings' | 'secretStorage'>;
export type SyncApiConnectionHost = ServerConnectionHost & Pick<CratePlugin, 'syncRuntime'>;

function connectionChanged(): DOMException {
	return new DOMException('The server connection changed. Reopen settings and try again.', 'AbortError');
}

/** Capture once for operations that span requests, queued saves and UI publication. */
export function captureServerConnection(plugin: ServerConnectionHost) {
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
export function captureSyncApiConnection(plugin: SyncApiConnectionHost) {
	const connection = captureServerConnection(plugin);
	const api = plugin.syncRuntime.getApiClient();
	const assertCurrent = () => {
		connection.assertCurrent();
		if (plugin.syncRuntime.getApiClient() !== api) throw connectionChanged();
	};
	return { ...connection, api, assertCurrent };
}

/** A client that runs `assertCurrent` before each request is sent and before its response is used. */
export function guardedServerClient(origin: string, token: string, assertCurrent: () => void): WorkerApiHttpClient {
	return new WorkerApiHttpClient(origin, token, async request => {
		assertCurrent();
		try { return await obsidianHttpTransport(request); }
		finally { assertCurrent(); }
	});
}

/** Bind request dispatch and response publication to the same connection. */
export async function serverRequest<T>(
	plugin: ServerConnectionHost,
	path: string,
	body?: unknown,
	{ timeout = 30_000, capabilities = {} }: ServerRequestOptions = {},
): Promise<T> {
	const { signal, origin, token, assertCurrent } = captureServerConnection(plugin);
	if (!origin || !token) throw new Error('Connect Crate to your server first.');
	const client = guardedServerClient(origin, token, assertCurrent);
	client.setAbortSignal(signal);
	const keys = loadEncryptionKeys(plugin.secretStorage);
	if (keys) client.setEncryptionAuthority(keys.vaultId, keys.generation);
	else client.refusePlaintext(Boolean(plugin.settings.encryptedVaultId));
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
