import type CratePlugin from './CratePlugin';
import { SECRET_KEYS } from './settings-types';

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
