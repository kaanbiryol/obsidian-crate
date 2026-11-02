import { Platform } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { SECRET_KEYS } from '../platform/secret-keys';

function normalizeDeviceId(value: string | null | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

export function ensurePluginDeviceId(plugin: CratePlugin): void {
	let nextDeviceId = normalizeDeviceId(plugin.secretStorage.get(SECRET_KEYS.DEVICE_ID));
	if (!nextDeviceId) {
		nextDeviceId = generateDeviceId();
		plugin.secretStorage.set(SECRET_KEYS.DEVICE_ID, nextDeviceId);
	}

	plugin.settings.deviceId = nextDeviceId;
}

function generateDeviceId(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);

	let id = 'device-';
	for (const value of bytes) {
		id += chars.charAt(value % chars.length);
	}

	return id;
}

function normalizeDeviceSuffix(deviceId: string): string {
	const suffix = deviceId.replace(/^device-/, '').slice(-4);
	return suffix || 'this';
}

export function getCurrentPlatformCode(): string {
	if (Platform.isIosApp) return 'ios';
	if (Platform.isAndroidApp) return 'android';
	if (Platform.isMacOS && Platform.isMobileApp) return 'ios';
	if (Platform.isWin) return 'windows';
	if (Platform.isLinux) return 'linux';
	if (Platform.isMacOS) return 'macos';
	if (Platform.isMobileApp) return 'mobile';
	if (Platform.isDesktopApp) return 'desktop';
	return 'unknown';
}

function getCurrentPlatformLabel(): string {
	switch (getCurrentPlatformCode()) {
		case 'ios':
			return 'iPhone or iPad';
		case 'android':
			return 'Android device';
		case 'macos':
			return 'Mac';
		case 'windows':
			return 'Windows PC';
		case 'linux':
			return 'Linux device';
		case 'mobile':
			return 'Mobile device';
		case 'desktop':
			return 'Desktop';
		default:
			return 'This device';
	}
}

export function getCurrentDeviceName(deviceId: string): string {
	return `${getCurrentPlatformLabel()} (${normalizeDeviceSuffix(deviceId)})`;
}
