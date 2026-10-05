import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '@/protocol';
import { capturePwaSession } from './session-generation';
import { ConnectionError } from './connection/issues';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { CRATE_WEB_SESSION_NAME_HEADER } from '@/protocol/web-session';
import { detectWebSessionName } from './session-label';
import { preparePwaEncryption, encryptionSnapshot } from './encryption-session';
import type { EncryptedReminderApi } from './encrypted-reminder-api';
import type { StoredReminderKeys } from './encryption-keys';
import { EncryptionScopeChangedError, routeFolderRequest } from './encryption-folder-routing';

export async function exchangeEnrollmentToken(token: string, previousAuthToken: string | null = null): Promise<string> {
	const protocol = await requireCompatibleServer();
	const response = await fetch('/notifications/reminders-exchange', {
		signal: AbortSignal.timeout(30_000),
		method: 'POST',
		headers: { 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(protocol) },
		body: JSON.stringify({ token, deviceName: detectWebSessionName(), ...(previousAuthToken ? { previousAuthToken } : {}) }),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new ConnectionError(response.status === 401 ? 'reconnect' : 'unavailable', body || response.statusText);
	}

	const result = await response.json() as { authToken?: string };
	if (!result.authToken) throw new ConnectionError('reconnect', 'Missing auth token');
	return result.authToken;
}

export function makeApiFetch(authToken: string | null, onUnauthorized: () => void) {
	const sessionCurrent = capturePwaSession();
	const clientSession = crypto.randomUUID();
	let keys: StoredReminderKeys | null = null;
	let encrypted: EncryptedReminderApi | null = null;
	let preparing: Promise<void> | undefined;
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
		if (isCrateMutation(path, init.method)) headers.set(CRATE_PROTOCOL_HEADER, String(await requireCompatibleServer()));
		if (!sessionCurrent() && !revokingSession) throw new ConnectionError('reconnect', 'Session changed. Open a fresh link from Crate.');
		headers.set('Authorization', `Bearer ${authToken}`);
		if (keys) {
			headers.set('X-Crate-Encryption-Vault', keys.vaultId);
			headers.set('X-Crate-Encryption-Generation', String(keys.generation));
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
		if (keys && response.status === 428 && path !== '/encryption') throw new EncryptionScopeChangedError('The encrypted folder changed.');
		return response;
	}
	function ready(refresh = false): Promise<void> {
		if (!authToken) return Promise.resolve();
		if (refresh) preparing = undefined;
		return preparing ??= preparePwaEncryption(authToken, rawFetch, refresh).then(async value => {
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

export async function fetchPwaAssetVersion(): Promise<string | null> {
	const response = await fetch(`/notifications/version.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
	if (!response.ok) return null;
	const result = await response.json() as { assetVersion?: string };
	return typeof result.assetVersion === 'string' && result.assetVersion.trim() ? result.assetVersion : null;
}

export async function registerPwaServiceWorker(): Promise<ServiceWorkerRegistration | null> {
	if (!('serviceWorker' in navigator)) return null;
	const existing = await navigator.serviceWorker.getRegistration('/notifications');
	// Startup and push checks reuse the registration even after another tab has
	// activated a newer shell. Only the update flow chooses a replacement version.
	if (existing && [existing.active, existing.waiting, existing.installing].some(worker => worker && worker.state !== 'redundant')) return existing;
	return navigator.serviceWorker.register(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`, {
		scope: '/notifications',
	});
}

type WindowWithPushManager = Window & {
	readonly pushManager?: PushManager;
};

interface PwaPushManagerOptions {
	windowPushManager?: PushManager | null;
	registerServiceWorker?: () => Promise<ServiceWorkerRegistration | null>;
}

function getWindowPushManager(): PushManager | null {
	if (typeof window === 'undefined') return null;
	return (window as WindowWithPushManager).pushManager ?? null;
}

export async function getPwaPushManager({
	windowPushManager = getWindowPushManager(),
	registerServiceWorker = registerPwaServiceWorker,
}: PwaPushManagerOptions = {}): Promise<PushManager | null> {
	if (windowPushManager && encryptionSnapshot().status === 'legacy') return windowPushManager;
	const registration = await registerServiceWorker();
	return registration?.pushManager ?? null;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
	const padding = '='.repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
	return outputArray;
}

async function requireCompatibleServer(): Promise<number> {
  const info = await (await import('./server-compatibility')).requireCompatibleServer();
  return Math.min(CRATE_PLUGIN_PROTOCOL.current, info.protocol.current);
}
