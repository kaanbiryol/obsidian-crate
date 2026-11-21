import { isRecord, isSha256Hex } from '../platform/validation';

/** A connected desktop lets a new device join its server with a one-use code. The
 * code is issued through the Cloudflare API, never by a device token, so a stolen
 * device credential cannot mint another one. */
export const DEVICE_PAIRING_CAPABILITY = 'device-pairing-v1';
export const DEVICE_PAIRING_PATH = '/auth/device-pairing';
export const DEVICE_PAIRING_PAGE = '/notifications/pair';
export const DEVICE_PAIRING_LIFETIME = 10 * 60_000;
/** The `grants` kind of a pending code, keyed by the code's hash. */
export const DEVICE_PAIRING_GRANT = 'device_pairing';

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

/** A self-hosted server's own code, issued on the server computer and redeemed at `/__crate/pair`. */
export const SELF_HOSTED_PAIRING_CODE = /^crate-pair-[a-f0-9]{64}$/;

/** `cloudflare` codes are redeemed through DEVICE_PAIRING_PATH, `self-hosted` ones by the local server. */
export interface DevicePairingTarget { origin: string; code: string; kind: 'cloudflare' | 'self-hosted' }

/** Accepts the page link or the `obsidian://crate-pair` parameters, returning the server origin and code. */
export function parseDevicePairingTarget(server: unknown, code: unknown): DevicePairingTarget | null {
	if (typeof server !== 'string' || typeof code !== 'string') return null;
	const kind = isSha256Hex(code) ? 'cloudflare' : SELF_HOSTED_PAIRING_CODE.test(code) ? 'self-hosted' : null;
	if (!kind) return null;
	try {
		const url = new URL(server);
		const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
		if (url.protocol !== 'https:' && !(local && url.protocol === 'http:') || url.username || url.password) return null;
		return { origin: url.origin, code, kind };
	} catch { return null; }
}

export function parseDevicePairingLink(link: string): DevicePairingTarget | null {
	try {
		const url = new URL(link.trim());
		if (url.protocol === 'obsidian:') return parseDevicePairingTarget(url.searchParams.get('server'), url.searchParams.get('code'));
		if (url.pathname !== DEVICE_PAIRING_PAGE) return null;
		return parseDevicePairingTarget(url.origin, url.hash.slice(1));
	} catch { return null; }
}
