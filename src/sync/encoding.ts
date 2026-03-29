/**
 * Base64 encoding/decoding helpers for batch API transfers.
 * Uses loop-based approach to avoid call stack overflow on large arrays.
 */

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 8192;
	let binary = '';
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return buffer;
}
