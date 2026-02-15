import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64, base64ToArrayBuffer } from './encoding';

describe('encoding round-trip', () => {
	it('round-trips text content', () => {
		const original = new TextEncoder().encode('Hello, world!');
		const b64 = arrayBufferToBase64(original.buffer as ArrayBuffer);
		const decoded = base64ToArrayBuffer(b64);

		expect(new Uint8Array(decoded)).toEqual(original);
	});

	it('round-trips binary content with all byte values', () => {
		const original = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			original[i] = i;
		}

		const b64 = arrayBufferToBase64(original.buffer as ArrayBuffer);
		const decoded = base64ToArrayBuffer(b64);

		expect(new Uint8Array(decoded)).toEqual(original);
	});

	it('round-trips empty buffer', () => {
		const original = new ArrayBuffer(0);
		const b64 = arrayBufferToBase64(original);
		const decoded = base64ToArrayBuffer(b64);

		expect(decoded.byteLength).toBe(0);
	});

	it('round-trips large buffer that spans multiple chunks', () => {
		const size = 16384 + 100;
		const original = new Uint8Array(size);
		for (let i = 0; i < size; i++) {
			original[i] = i % 256;
		}

		const b64 = arrayBufferToBase64(original.buffer as ArrayBuffer);
		const decoded = base64ToArrayBuffer(b64);

		expect(new Uint8Array(decoded)).toEqual(original);
	});
});
