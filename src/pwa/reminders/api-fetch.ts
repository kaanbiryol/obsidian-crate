import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '@/protocol/server-info';
import { capturePwaSession } from '../session-generation';
import { ConnectionError } from '../connection/issues';
import { CRATE_WEB_SESSION_NAME_HEADER } from '@/protocol/web-session';
import { detectWebSessionName } from '../session-label';
import { prepareReminderEncryption } from './encryption-session';
import type { EncryptedReminderApi } from './encrypted-reminder-api';
import type { StoredReminderKeys } from '../encryption/encryption-keys';
import { EncryptionScopeChangedError, routeFolderRequest } from '../encryption/encryption-folder-routing';
import { requestSharedFeaturesRefresh } from '../shared-features';
import { ENCRYPTION_GENERATION_HEADER, ENCRYPTION_STATE_HEADER, ENCRYPTION_VAULT_HEADER } from '@/encryption/server-state';
import { requireCompatibleProtocol } from '../server-compatibility';

export function makeApiFetch(authToken: string | null, onUnauthorized: () => void) {
	const sessionCurrent = capturePwaSession();
	const clientSession = crypto.randomUUID();
	let keys: StoredReminderKeys | null = null;
	let encrypted: EncryptedReminderApi | null = null;
	let preparing: Promise<void> | undefined;
	// The server's last response said this vault is not encrypted.
	let encryptionOff = false;
	async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
		if (!sessionCurrent()) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		if (!authToken) throw new ConnectionError('reconnect', 'Not authenticated');
		// Capture authority at invocation. Only revocation may finish dispatching
		// after logout clears local state; it can only revoke this captured token.
		const revokingSession = init.method === 'DELETE' && path === '/auth/session';
		const headers = new Headers(init.headers ?? {});
		headers.set('X-Crate-Client-Session', clientSession);
		headers.set(CRATE_WEB_SESSION_NAME_HEADER, encodeURIComponent(detectWebSessionName()));
		if (typeof init.body === 'string') {
			try {
				const body = JSON.parse(init.body) as { operationId?: unknown };
				if (typeof body.operationId === 'string') headers.set('X-Crate-Operation-Id', body.operationId);
			} catch { /* Non-JSON requests use their server request ID. */ }
		}
		headers.set(CRATE_PROTOCOL_HEADER, String(CRATE_PLUGIN_PROTOCOL.current));
		if (isCrateMutation(path, init.method)) headers.set(CRATE_PROTOCOL_HEADER, String(await requireCompatibleProtocol()));
		if (!sessionCurrent() && !revokingSession) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		headers.set('Authorization', `Bearer ${authToken}`);
		if (keys) {
			headers.set(ENCRYPTION_VAULT_HEADER, keys.vaultId);
			headers.set(ENCRYPTION_GENERATION_HEADER, String(keys.generation));
		}
		if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

		const response = await fetch(path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
		if (!sessionCurrent() && !revokingSession) {
			throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		}
		if (response.status === 401 && sessionCurrent()) {
			onUnauthorized();
			throw new ConnectionError('reconnect', 'Session expired. Open a fresh link from Crate.');
		}
		const encryptionState = response.headers.get(ENCRYPTION_STATE_HEADER);
		if (encryptionState === 'off' || encryptionState === 'on') encryptionOff = encryptionState === 'off';
		// Without keys, a 428 from a newly encrypted vault retries after a fresh probe.
		if ((keys || encryptionState === 'on') && response.status === 428 && path !== '/encryption') throw new EncryptionScopeChangedError('The encrypted folder changed.');
		if (response.status === 423) requestSharedFeaturesRefresh(true);
		return response;
	}
	function ready(refresh = false): Promise<void> {
		if (!authToken) return Promise.resolve();
		// Unencrypted vaults skip the probe while responses confirm it stays off.
		if (!refresh && encryptionOff && !keys) return Promise.resolve();
		if (refresh) preparing = undefined;
		return preparing ??= prepareReminderEncryption(authToken, rawFetch, refresh).then(async value => {
			const Constructor = value ? (await import('./encrypted-reminder-api')).EncryptedReminderApi : null;
			if (!sessionCurrent()) throw new ConnectionError('reconnect', 'Session changed before unlocking');
			keys = value;
			encrypted = keys && Constructor ? new Constructor(keys, rawFetch) : null;
		}).finally(() => { if (!keys) preparing = undefined; });
	}
	async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
		if (!sessionCurrent()) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		if (path === '/encryption' || (path === '/auth/session' && init.method === 'DELETE')) return rawFetch(path, init);
		for (let attempt = 0; ; attempt++) {
			await ready(attempt > 0);
			try {
				if (encrypted) {
					const response = await encrypted.handle(path, init);
					if (response) return response;
				}
				const routed = keys ? routeFolderRequest(path, init, keys.localFolderPath ?? keys.folderPath, keys.folderPath) : { path, init };
				return await rawFetch(routed.path, routed.init);
			} catch (error) { if (!(error instanceof EncryptionScopeChangedError) || attempt > 0) throw error; }
		}
	}
	return Object.assign(apiFetch, { ready });
}

