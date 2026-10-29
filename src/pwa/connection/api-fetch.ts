import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '@/protocol/server-info';
import { capturePwaSession } from './session-generation';
import { ConnectionError } from './issues';
import { CRATE_WEB_SESSION_NAME_HEADER, REMINDERS_FOLDER_CHANGED } from '@/protocol/web-session';
import { adoptReminderFolder } from '../config';
import { CLIENT_SESSION_HEADER, OPERATION_ID_HEADER } from '@/protocol/http-headers';
import { detectWebSessionName } from './session-label';
import { prepareReminderEncryption } from '../reminders/encryption-session';
import type { FeatureKeys } from '../encryption/encryption-keys';
import { checkEncryptionSignals, retryAfterEncryptionChange } from '../encryption/encryption-retry';
import { ENCRYPTION_GENERATION_HEADER, ENCRYPTION_STATE_HEADER, ENCRYPTION_VAULT_HEADER } from '@/encryption/server-state';
import { requireCompatibleProtocol } from './server-compatibility';
import { EncryptedReminderApi } from '../reminders/encrypted-reminder-api';

// The token and session whose latest authenticated response said the vault is not
// encrypted, and when that request was sent. Shared so the app's client trusts the
// startup probe instead of repeating it.
let encryptionOff: { token: string; current: () => boolean; at: number } | null = null;
// Bumped whenever that verdict is dropped, so a response already in flight cannot restore it.
let encryptionOffResets = 0;
/** How long that verdict lets a change skip the probe before sending plaintext. */
const ENCRYPTION_OFF_TRUST_MS = 30_000;
function forgetEncryptionOff(): void {
	encryptionOff = null;
	encryptionOffResets++;
}

export function makeApiFetch(authToken: string | null, onUnauthorized: () => void) {
	const sessionCurrent = capturePwaSession();
	const clientSession = crypto.randomUUID();
	let keys: FeatureKeys | null = null;
	let encrypted: EncryptedReminderApi | null = null;
	let preparing: Promise<void> | undefined;
	async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
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
		headers.set(CRATE_PROTOCOL_HEADER, String(CRATE_PLUGIN_PROTOCOL.current));
		if (isCrateMutation(path, init.method)) headers.set(CRATE_PROTOCOL_HEADER, String(await requireCompatibleProtocol()));
		if (!sessionCurrent() && !revokingSession) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		headers.set('Authorization', `Bearer ${authToken}`);
		if (keys) {
			headers.set(ENCRYPTION_VAULT_HEADER, keys.vaultId);
			headers.set(ENCRYPTION_GENERATION_HEADER, String(keys.generation));
		}
		if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

		const dispatched = { at: performance.now(), resets: encryptionOffResets };
		const response = await fetch(path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
		if (!sessionCurrent() && !revokingSession) {
			throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		}
		const encryptionState = response.headers.get(ENCRYPTION_STATE_HEADER);
		// A refusal may mean another device turned encryption on and revoked or locked this credential.
		if (encryptionState === 'on' || [401, 403, 423, 428].includes(response.status)) forgetEncryptionOff();
		else if (encryptionState === 'off' && dispatched.resets === encryptionOffResets) encryptionOff = { token: authToken, current: sessionCurrent, at: dispatched.at };
		if (response.status === 401 && sessionCurrent()) {
			onUnauthorized();
			throw new ConnectionError('reconnect', 'Session expired. Open a fresh link from Crate.');
		}
		// Without keys, a 428 from a newly encrypted vault retries after a fresh probe.
		checkEncryptionSignals(response, path, { probePath: '/encryption', message: 'The vault encryption changed.', encrypted: Boolean(keys) || encryptionState === 'on' });
		if (response.status === 403 && path.startsWith('/reminders/')) await followFolderChange(response);
		return response;
	}
	/** Obsidian changed the reminders folder and the server moved this session with it. */
	async function followFolderChange(response: Response): Promise<void> {
		const body = await response.clone().json().catch(() => null) as { code?: unknown; folderPath?: unknown } | null;
		if (body?.code !== REMINDERS_FOLDER_CHANGED || typeof body.folderPath !== 'string' || !body.folderPath) return;
		// An encrypted folder's name comes from its sealed label, which the refresh opens.
		if (keys) await ready(true);
		else adoptReminderFolder(body.folderPath);
		throw new ConnectionError('unavailable', 'The reminders folder changed in Obsidian. Showing the new folder.');
	}
	/** `beforeChange` trusts only a recent unencrypted verdict before a request sends plaintext. */
	function ready(refresh = false, beforeChange = false): Promise<void> {
		if (!authToken) return Promise.resolve();
		// Unencrypted vaults skip the probe while responses confirm it stays off.
		if (!refresh && !keys && encryptionOff?.token === authToken && encryptionOff.current()
			&& (!beforeChange || performance.now() - encryptionOff.at < ENCRYPTION_OFF_TRUST_MS)) return Promise.resolve();
		if (refresh) preparing = undefined;
		return preparing ??= prepareReminderEncryption(authToken, rawFetch, refresh).then(value => {
			if (!sessionCurrent()) throw new ConnectionError('reconnect', 'Session changed before unlocking');
			keys = value;
			encrypted = keys ? new EncryptedReminderApi(keys, rawFetch) : null;
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
	return Object.assign(apiFetch, { ready });
}

