import { isRecord, isSha256Hex } from '../platform/validation';

/** A connected desktop lets a new device join its server with a one-use code. The
 * code is issued through the Cloudflare API, never by a device token, so a stolen
 * device credential cannot mint another one. */
export const DEVICE_PAIRING_CAPABILITY = 'device-pairing-v1';
export const DEVICE_PAIRING_PATH = '/auth/device-pairing';
export const DEVICE_PAIRING_PAGE = '/notifications/pair';
export const DEVICE_PAIRING_LIFETIME = 10 * 60_000;
/** `maintenance_state` keys between these bounds hold pending codes, keyed by the code's hash. */
export const DEVICE_PAIRING_PREFIX = 'crate_device_pairing:';
export const DEVICE_PAIRING_END = 'crate_device_pairing;';

/** A pending code. `redeemed` holds the new device's token hash once claimed, so a
 * lost response can be retried until the code expires. */
export interface DevicePairingRecord {
	id: string;
	expiresAt: number;
	resetGeneration: string;
	deployment: Record<string, unknown>;
	redeemed?: string;
}

export function parseDevicePairingRecord(value: string): DevicePairingRecord | null {
	try {
		const record: unknown = JSON.parse(value);
		if (!isRecord(record) || typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id)
			|| !Number.isSafeInteger(record.expiresAt) || typeof record.resetGeneration !== 'string'
			|| !isRecord(record.deployment) || record.redeemed !== undefined && !isSha256Hex(record.redeemed)) return null;
		return record as unknown as DevicePairingRecord;
	} catch { return null; }
}

/** The QR link opens a Worker page; the code stays in the fragment, which browsers never send. */
export function devicePairingLink(origin: string, code: string): string {
	return `${new URL(origin).origin}${DEVICE_PAIRING_PAGE}#${code}`;
}

/** Accepts the page link or the `obsidian://crate-pair` parameters, returning the server origin and code. */
export function parseDevicePairingTarget(server: unknown, code: unknown): { origin: string; code: string } | null {
	if (typeof server !== 'string' || !isSha256Hex(code)) return null;
	try {
		const url = new URL(server);
		const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
		if (url.protocol !== 'https:' && !(local && url.protocol === 'http:') || url.username || url.password) return null;
		return { origin: url.origin, code };
	} catch { return null; }
}

export function parseDevicePairingLink(link: string): { origin: string; code: string } | null {
	try {
		const url = new URL(link.trim());
		if (url.protocol === 'obsidian:') return parseDevicePairingTarget(url.searchParams.get('server'), url.searchParams.get('code'));
		if (url.pathname !== DEVICE_PAIRING_PAGE) return null;
		return parseDevicePairingTarget(url.origin, url.hash.slice(1));
	} catch { return null; }
}
