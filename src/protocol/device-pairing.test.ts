import { describe, expect, it } from 'vitest';
import { devicePairingLink, parseDevicePairingLink, parseDevicePairingRecord, parseDevicePairingTarget } from './device-pairing';

const code = 'a'.repeat(64);

describe('device pairing links', () => {
	it('keeps the code in the fragment and reads it back from the page or the Obsidian link', () => {
		const link = devicePairingLink('https://crate-0123456789abcdef.example.workers.dev/', code);
		expect(link).toBe(`https://crate-0123456789abcdef.example.workers.dev/notifications/pair#${code}`);
		expect(parseDevicePairingLink(link)).toEqual({ origin: 'https://crate-0123456789abcdef.example.workers.dev', code });
		expect(parseDevicePairingLink(`obsidian://crate-pair?server=${encodeURIComponent('https://crate.example.workers.dev')}&code=${code}`))
			.toEqual({ origin: 'https://crate.example.workers.dev', code });
	});

	it.each([
		['plain HTTP', 'http://crate.example.com', code],
		['credentials', 'https://user:pass@crate.example.com', code],
		['a short code', 'https://crate.example.com', 'abc'],
		['an uppercase code', 'https://crate.example.com', code.toUpperCase()],
		['a missing server', undefined, code],
	])('rejects %s', (_label, server, value) => {
		expect(parseDevicePairingTarget(server, value)).toBeNull();
	});

	it('allows local development servers over HTTP', () => {
		expect(parseDevicePairingTarget('http://localhost:8787', code)).toEqual({ origin: 'http://localhost:8787', code });
	});

	it('rejects links to other pages', () => {
		expect(parseDevicePairingLink(`https://crate.example.com/notifications#${code}`)).toBeNull();
		expect(parseDevicePairingLink('not a link')).toBeNull();
	});

	it('accepts only well-formed stored records', () => {
		const record = { id: 'b'.repeat(32), expiresAt: 1, resetGeneration: '', deployment: {} };
		expect(parseDevicePairingRecord(JSON.stringify(record))).toEqual(record);
		expect(parseDevicePairingRecord(JSON.stringify({ ...record, redeemed: 'x' }))).toBeNull();
		expect(parseDevicePairingRecord(JSON.stringify({ ...record, id: 'short' }))).toBeNull();
		expect(parseDevicePairingRecord('{')).toBeNull();
	});
});
