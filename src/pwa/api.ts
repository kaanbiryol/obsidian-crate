import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '@/protocol';
import { capturePwaSession } from './session-generation';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import {
	detectDeviceName,
} from './config';

export async function exchangeEnrollmentToken(token: string): Promise<string> {
	await requireCompatibleServer();
	const response = await fetch('/notifications/reminders-exchange', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) },
		body: JSON.stringify({ token, deviceName: detectDeviceName() }),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(body || response.statusText);
	}

	const result = await response.json() as { authToken?: string };
	if (!result.authToken) throw new Error('Missing auth token');
	return result.authToken;
}

export function makeApiFetch(authToken: string | null, onUnauthorized: () => void) {
	const sessionCurrent = capturePwaSession();
	const clientSession = crypto.randomUUID();
	return async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
		if (!sessionCurrent()) throw new Error('Session changed. Open a fresh link from Crate.');
		if (!authToken) throw new Error('Not authenticated');
		// Capture authority at invocation. Only revocation may finish dispatching
		// after logout clears local state; it can only revoke this captured token.
		const revokingSession = init.method === 'DELETE' && path === '/auth/session';
		const headers = new Headers(init.headers ?? {});
		headers.set('X-Crate-Client-Session', clientSession);
		if (typeof init.body === 'string') {
			try {
				const body = JSON.parse(init.body) as { operationId?: unknown };
				if (typeof body.operationId === 'string') headers.set('X-Crate-Operation-Id', body.operationId);
			} catch { /* Non-JSON requests use their server request ID. */ }
		}
		headers.set(CRATE_PROTOCOL_HEADER, String(CRATE_PLUGIN_PROTOCOL.current));
		if (isCrateMutation(path, init.method)) await requireCompatibleServer();
		if (!sessionCurrent() && !revokingSession) throw new Error('Session changed. Open a fresh link from Crate.');
		headers.set('Authorization', `Bearer ${authToken}`);
		if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

		const response = await fetch(path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
		if (!sessionCurrent() && !revokingSession) {
			throw new Error('Session changed. Open a fresh link from Crate.');
		}
		if (response.status === 401 && sessionCurrent()) {
			onUnauthorized();
			throw new Error('Session expired. Open a fresh link from Crate.');
		}
		return response;
	};
}

export async function fetchPwaAssetVersion(): Promise<string | null> {
	const response = await fetch(`/notifications/version.json?ts=${Date.now()}`, { cache: 'no-store' });
	if (!response.ok) return null;
	const result = await response.json() as { assetVersion?: string };
	return typeof result.assetVersion === 'string' && result.assetVersion.trim() ? result.assetVersion : null;
}

export async function registerPwaServiceWorker(): Promise<ServiceWorkerRegistration | null> {
	if (!('serviceWorker' in navigator)) return null;
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
	if (windowPushManager) return windowPushManager;
	const registration = await registerServiceWorker();
	return registration?.pushManager ?? null;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
	return outputArray;
}

async function requireCompatibleServer(): Promise<void> {
  await (await import('./server-compatibility')).requireCompatibleServer();
}
