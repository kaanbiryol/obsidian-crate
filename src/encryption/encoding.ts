/** Canonical base64url, usable in Obsidian, browsers, and service workers. */
export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function validateBase64Url(value: string, maximumBytes: number): number {
	if (value.length > Math.ceil(maximumBytes * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
		throw new Error('Invalid encrypted data encoding');
	}
	const length = Math.floor(value.length * 3 / 4);
	const last = value.length ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(value[value.length - 1]!) : 0;
	if (length > maximumBytes || (value.length % 4 === 2 && (last & 15) !== 0) || (value.length % 4 === 3 && (last & 3) !== 0)) throw new Error('Invalid encrypted data encoding');
	return length;
}

export function decodeBase64Url(value: string, maximumBytes: number): Uint8Array<ArrayBuffer> {
	const length = validateBase64Url(value, maximumBytes);
	const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function isEncryptionId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
