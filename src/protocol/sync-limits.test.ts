import { expect, it } from 'vitest';
import { deviceFileLimit, formatFileLimit, MAX_CONFIGURABLE_FILE_BYTES, MAX_FILE_SIZE_BYTES, parseMaxFileBytes } from './sync-limits';
import { serverMaxFileBytes, serverProtocolRange, CRATE_PLUGIN_PROTOCOL } from './server-info';
import { encryptedFileLimit, fileTransportLimit, ENCRYPTED_FILE_CONTENT_TYPE, MAX_ENCRYPTED_FILE_BYTES } from '../encryption/file-format';

const MB = 1024 * 1024;

it('accepts a configured file limit only between the default and the ceiling', () => {
	expect(parseMaxFileBytes(undefined)).toBe(MAX_FILE_SIZE_BYTES);
	expect(parseMaxFileBytes(String(100 * MB))).toBe(100 * MB);
	expect(parseMaxFileBytes(100 * MB)).toBe(100 * MB);
	for (const value of [MAX_FILE_SIZE_BYTES - 1, MAX_CONFIGURABLE_FILE_BYTES + 1, '1e9', '-5', 1.5, null, {}]) {
		expect(parseMaxFileBytes(value)).toBe(MAX_FILE_SIZE_BYTES);
	}
});

it('keeps mobile devices at the default limit', () => {
	expect(deviceFileLimit(100 * MB, true)).toBe(MAX_FILE_SIZE_BYTES);
	expect(deviceFileLimit(100 * MB, false)).toBe(100 * MB);
	expect(deviceFileLimit(MAX_FILE_SIZE_BYTES, true)).toBe(MAX_FILE_SIZE_BYTES);
	expect(formatFileLimit(MAX_FILE_SIZE_BYTES)).toBe('25MB');
});

it('narrows the protocol range only when a server raises its limit', () => {
	expect(serverProtocolRange(MAX_FILE_SIZE_BYTES)).toBe(CRATE_PLUGIN_PROTOCOL);
	expect(serverProtocolRange(30 * MB)).toEqual({ current: CRATE_PLUGIN_PROTOCOL.current, oldestCompatible: 2 });
	expect(serverMaxFileBytes({})).toBe(MAX_FILE_SIZE_BYTES);
	expect(serverMaxFileBytes({ limits: { maxFileBytes: 30 * MB } })).toBe(30 * MB);
});

it('derives the encrypted transport limit, keeping the released 38 MiB at the default', () => {
	expect(encryptedFileLimit(MAX_FILE_SIZE_BYTES)).toBe(MAX_ENCRYPTED_FILE_BYTES);
	expect(fileTransportLimit(ENCRYPTED_FILE_CONTENT_TYPE)).toBe(MAX_ENCRYPTED_FILE_BYTES);
	expect(fileTransportLimit(ENCRYPTED_FILE_CONTENT_TYPE, 100 * MB)).toBeGreaterThan(Math.ceil(100 * MB * 4 / 3));
	expect(fileTransportLimit('text/markdown', 100 * MB)).toBe(100 * MB);
});

it('keeps an encrypted upload journal record at the ceiling below the JavaScript string limit', () => {
	// The record holds the plaintext and the sealed file, each base64-encoded.
	const characters = Math.ceil(MAX_CONFIGURABLE_FILE_BYTES * 4 / 3) + Math.ceil(encryptedFileLimit(MAX_CONFIGURABLE_FILE_BYTES) * 4 / 3);
	expect(characters).toBeLessThan(2 ** 29 - 24 - 16 * MB);
});
