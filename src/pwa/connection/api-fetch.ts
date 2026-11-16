import { CRATE_PROTOCOL_HEADER, isCrateMutation } from '@/protocol/server-info';
import { capturePwaSession } from './session-generation';
import { ConnectionError } from './issues';
import { CRATE_WEB_SESSION_NAME_HEADER } from '@/protocol/web-session';
import { CLIENT_SESSION_HEADER, OPERATION_ID_HEADER } from '@/protocol/http-headers';
import { detectWebSessionName } from './session-label';
import type { FeatureKeys } from '../encryption/encryption-keys';
import { checkEncryptionSignals, retryAfterEncryptionChange } from '../encryption/encryption-retry';
import { encryptionOffDispatch, noteEncryptionReport, trustsEncryptionOff } from '../encryption/encryption-off-trust';
import { ENCRYPTION_GENERATION_HEADER, ENCRYPTION_STATE_HEADER, ENCRYPTION_VAULT_HEADER } from '@/encryption/server-state';
import { crateProtocol, forgetRefusedProtocol } from './request-headers';
import type { ApiFetch } from '../types';

/** The feature that checks this credential's encryption and answers its encrypted requests;
 * Reminders supplies it (`pwa/reminders/reminder-transport.ts`). */
export interface ApiFetchEncryption {
	/** Checks the server's encryption state and unlocks keys; null when the vault is not encrypted. */
	prepare(token: string, rawFetch: ApiFetch, refresh: boolean): Promise<FeatureKeys | null>;
	/** The client for unlocked keys. It answers the requests it serves, or null to send one as is. */
	router(keys: FeatureKeys, rawFetch: ApiFetch): { handle(path: string, init: RequestInit): Promise<Response | null> };
	/** Sees each response before its caller and may throw instead; `refresh` checks encryption again. */
	inspect(path: string, response: Response, session: { encrypted(): boolean; refresh(): Promise<void> }): Promise<void>;
}

export function makeApiFetch(authToken: string | null, onUnauthorized: () => void, encryption: ApiFetchEncryption) {
	const sessionCurrent = capturePwaSession();
	const clientSession = crypto.randomUUID();
	let keys: FeatureKeys | null = null;
	let encrypted: ReturnType<ApiFetchEncryption['router']> | null = null;
	let preparing: Promise<void> | undefined;
	async function rawFetch(path: string, init: RequestInit = {}, unverified = false): Promise<Response> {
		if (!sessionCurrent()) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		if (!authToken) throw new ConnectionError('reconnect', 'Not authenticated');
		// Capture authority at invocation. Only revocation may finish dispatching
		// after logout clears local state; it can only revoke this captured token.
		const revokingSession = init.method === 'DELETE' && path === '/auth/session';
		const headers = new Headers(init.headers ?? {});
		headers.set(CLIENT_SESSION_HEADER, clientSession);
		headers.set(CRATE_WEB_SESSION_NAME_HEADER, encodeURIComponent(detectWebSessionName()));
		if (typeof init.body === 'string') {
			try {
				const body = JSON.parse(init.body) as { operationId?: unknown };
				if (typeof body.operationId === 'string') headers.set(OPERATION_ID_HEADER, body.operationId);
			} catch { /* Non-JSON requests use their server request ID. */ }
		}
		headers.set(CRATE_PROTOCOL_HEADER, String(await crateProtocol(path, init.method)));
		if (!sessionCurrent() && !revokingSession) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		headers.set('Authorization', `Bearer ${authToken}`);
		if (keys) {
			headers.set(ENCRYPTION_VAULT_HEADER, keys.vaultId);
			headers.set(ENCRYPTION_GENERATION_HEADER, String(keys.generation));
		}
		if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

		const dispatched = encryptionOffDispatch();
		const response = await fetch(path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
		if (!sessionCurrent() && !revokingSession) {
			throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		}
		const encryptionState = response.headers.get(ENCRYPTION_STATE_HEADER);
		noteEncryptionReport(response, dispatched, { token: authToken, current: sessionCurrent, unverified });
		if (response.status === 401 && sessionCurrent()) {
			onUnauthorized();
			throw new ConnectionError('reconnect', 'Session expired. Open a fresh link from Crate.');
		}
		await forgetRefusedProtocol(response);
		// Without keys, a 428 from a newly encrypted vault retries after a fresh probe.
		checkEncryptionSignals(response, path, { probePath: '/encryption', message: 'The vault encryption changed.', encrypted: Boolean(keys) || encryptionState === 'on' });
		await encryption.inspect(path, response, { encrypted: () => Boolean(keys), refresh: () => ready(true) });
		return response;
	}
	/** `beforeChange` trusts only a recent unencrypted verdict before a request sends plaintext. */
	function ready(refresh = false, beforeChange = false): Promise<void> {
		if (!authToken) return Promise.resolve();
		// Unencrypted vaults skip the probe while responses confirm it stays off.
		if (!refresh && !keys && trustsEncryptionOff(authToken, beforeChange)) return Promise.resolve();
		if (refresh) preparing = undefined;
		return preparing ??= encryption.prepare(authToken, rawFetch, refresh).then(value => {
			if (!sessionCurrent()) throw new ConnectionError('reconnect', 'Session changed before unlocking');
			keys = value;
			encrypted = keys ? encryption.router(keys, rawFetch) : null;
		}).finally(() => { if (!keys) preparing = undefined; });
	}
	async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
		if (!sessionCurrent()) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		if (path === '/encryption' || (path === '/auth/session' && init.method === 'DELETE')) return rawFetch(path, init);
		return retryAfterEncryptionChange(async refresh => {
			await ready(refresh, isCrateMutation(path, init.method));
			if (encrypted) {
				const response = await encrypted.handle(path, init);
				if (response) return response;
			}
			return rawFetch(path, init);
		});
	}
	/** A plaintext read sent while the startup encryption check is still running, on a
	 * device without encryption evidence. Callers apply its response only once that
	 * check accepts unencrypted mode. */
	function readUnverified(path: string, init: RequestInit = {}): Promise<Response> {
		if (keys || (init.method ?? 'GET') !== 'GET') return apiFetch(path, init);
		return rawFetch(path, init, true);
	}
	return Object.assign(apiFetch, { ready, readUnverified });
}

