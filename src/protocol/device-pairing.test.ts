import { describe, expect, it } from 'vitest';
import { devicePairingLink, parseDevicePairingLink, parseDevicePairingRecord, parseDevicePairingTarget } from './device-pairing';

const code = 'a'.repeat(64);

describe('device pairing links', () => {
	it('keeps the code in the fragment and reads it back from the page or the Obsidian link', () => {
		const link = devicePairingLink('https://crate-0123456789abcdef.example.workers.dev/', code);
		expect(link).toBe(`https://crate-0123456789abcdef.example.workers.dev/notifications/pair#${code}`);
		expect(parseDevicePairingLink(link)).toEqual({ origin: 'https://crate-0123456789abcdef.example.workers.dev', code, kind: 'cloudflare' });
		expect(parseDevicePairingLink(`obsidian://crate-pair?server=${encodeURIComponent('https://crate.example.workers.dev')}&code=${code}`))
			.toEqual({ origin: 'https://crate.example.workers.dev', code, kind: 'cloudflare' });
	});

	it('reads a self-hosted server code from the page or the Obsidian link', () => {
		const local = `crate-pair-${code}`;
		expect(parseDevicePairingLink(devicePairingLink('https://crate.tail1234.ts.net', local)))
			.toEqual({ origin: 'https://crate.tail1234.ts.net', code: local, kind: 'self-hosted' });
		expect(parseDevicePairingLink(`obsidian://crate-pair?server=${encodeURIComponent('http://localhost:8787')}&code=${local}`))
			.toEqual({ origin: 'http://localhost:8787', code: local, kind: 'self-hosted' });
		expect(parseDevicePairingTarget('https://crate.example.com', `crate-pair-${'a'.repeat(63)}`)).toBeNull();
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
		expect(parseDevicePairingTarget('http://localhost:8787', code)).toEqual({ origin: 'http://localhost:8787', code, kind: 'cloudflare' });
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
