import { PWA_ASSET_VERSION } from '../pwa-version';
import {
	currentQueryParams,
	detectDeviceName,
	parseStartTab,
} from './config';
import type { StoredConfig } from './types';

export async function exchangeEnrollmentToken(token: string): Promise<string> {
	const response = await fetch('/notifications/reminders-exchange', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
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

export async function validateStoredAuthToken(authToken: string): Promise<boolean> {
	try {
		const response = await fetch('/health', {
			headers: { Authorization: `Bearer ${authToken}` },
		});
		return response.status !== 401 && response.status !== 403;
	} catch {
		return true;
	}
}

function installActivationParams(token: string, config: StoredConfig): URLSearchParams {
	const params = currentQueryParams();
	const project = params.get('project');
	const tab = parseStartTab(params.get('tab'));
	const nextParams = new URLSearchParams();
	nextParams.set('token', token);
	nextParams.set('folder', config.folderPath);
	nextParams.set('upcomingDays', String(config.upcomingDays));
	if (config.allDayNotificationTime) nextParams.set('allDayTime', config.allDayNotificationTime);
	if (project) nextParams.set('project', project);
	if (tab) nextParams.set('tab', tab);
	return nextParams;
}

function updateManifestWithInstallToken(token: string, config: StoredConfig): void {
	const params = installActivationParams(token, config);
	params.set('v', PWA_ASSET_VERSION);
	const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
	if (manifest) {
		manifest.href = `/notifications/manifest.json?${params.toString()}`;
	}
}

export function replaceBrowserUrlWithInstallToken(token: string, config: StoredConfig): void {
	const params = installActivationParams(token, config);

	const query = params.toString();
	history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
	updateManifestWithInstallToken(token, config);
}

export function makeApiFetch(authToken: string | null, onUnauthorized: () => void) {
	return async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
		if (!authToken) throw new Error('Not authenticated');
		const headers = new Headers(init.headers ?? {});
		headers.set('Authorization', `Bearer ${authToken}`);
		if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

		const response = await fetch(path, { ...init, headers });
		if (response.status === 401) {
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
	return navigator.serviceWorker.register(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`);
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
	return outputArray;
}
