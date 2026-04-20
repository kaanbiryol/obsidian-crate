import type CratePlugin from './CratePlugin';
import { SECRET_KEYS } from './types';

function normalizeDeviceId(value: string | null | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

export async function ensurePluginDeviceId(plugin: CratePlugin): Promise<void> {
	const localDeviceId = normalizeDeviceId(plugin.secretStorage.get(SECRET_KEYS.DEVICE_ID));
	const legacyDeviceId = normalizeDeviceId(plugin.settings.deviceId);

	let nextDeviceId = localDeviceId;
	let shouldSaveSettings = legacyDeviceId.length > 0;

	if (!nextDeviceId) {
		nextDeviceId = legacyDeviceId && plugin.secretStorage.has(SECRET_KEYS.AUTH_TOKEN)
			? legacyDeviceId
			: generateDeviceId();
		plugin.secretStorage.set(SECRET_KEYS.DEVICE_ID, nextDeviceId);
		shouldSaveSettings = true;
	}

	plugin.settings.deviceId = nextDeviceId;

	if (shouldSaveSettings) {
		await plugin.saveSettings();
	}
}

export async function setPluginDeviceId(plugin: CratePlugin, value: string): Promise<void> {
	const nextDeviceId = normalizeDeviceId(value);
	if (nextDeviceId) {
		plugin.secretStorage.set(SECRET_KEYS.DEVICE_ID, nextDeviceId);
	} else {
		plugin.secretStorage.delete(SECRET_KEYS.DEVICE_ID);
	}
	plugin.settings.deviceId = nextDeviceId;
	await plugin.saveSettings();
}

export function generateDeviceId(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);

	let id = 'device-';
	for (const value of bytes) {
		id += chars.charAt(value % chars.length);
	}

	return id;
}
