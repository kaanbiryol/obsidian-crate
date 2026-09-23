import { describe, expect, it } from 'vitest';
import { selfHostedConnectionMessage, syncConnectionFailureMessage } from './self-hosted-errors';

describe('self-hosted connection messages', () => {
	it('explains the connection-refused error and Docker address choice', () => {
		const message = selfHostedConnectionMessage(new Error('net::ERR_CONNECTION_REFUSED'), 'http://localhost:8787');
		expect(message).toContain('server on this device');
		expect(message).toContain('HTTPS address from the Docker logs');
		expect(message).not.toContain('ERR_');
	});
	it('distinguishes a remote refusal from a local-only address', () => {
		expect(selfHostedConnectionMessage(new Error('ECONNREFUSED'), 'https://crate.example')).toContain('current HTTPS address');
	});
	it('explains temporary hostname propagation and address rotation', () => {
		expect(selfHostedConnectionMessage(new Error('net::ERR_NAME_NOT_RESOLVED'), 'https://new.trycloudflare.com')).toContain('wait a moment');
		expect(selfHostedConnectionMessage(new Error('ENOTFOUND'), 'https://crate.example')).toContain('internet connection');
	});
	it.each([
		[401, 'access token'], [403, 'Obsidian vault'], [429, 'Wait a minute'],
		[502, 'tunnel cannot reach Crate'], [404, 'Crate was not found'],
	])('handles HTTP %s without displaying raw server content', (status, expected) => {
		const error = Object.assign(new Error('<html>private server response</html>'), { status });
		const message = selfHostedConnectionMessage(error, 'https://test.trycloudflare.com');
		expect(message).toContain(expected);
		expect(message).not.toContain('private server response');
	});
	it.each([
		['HTTP 401: Unauthorized', 'access token'],
		['Request timed out after 30000ms', 'too long'],
		['net::ERR_CERT_AUTHORITY_INVALID', 'certificate'],
		['Incompatible Crate server protocol 99', 'Update the plugin and server'],
		['Server returned invalid Crate compatibility metadata', 'did not return a Crate server'],
		['Invalid JSON response for /health: unexpected token', 'did not return a Crate server'],
	])('handles flattened API failures: %s', (error, expected) => {
		expect(selfHostedConnectionMessage(new Error(error), 'https://crate.example')).toContain(expected);
	});
	it('preserves actionable setup validation and sanitizes unknown failures', () => {
		const validation = 'Disconnect this device before connecting another server.';
		expect(selfHostedConnectionMessage(new Error(validation), '')).toBe(validation);
		for (const error of [new Error('unexpected internals with secret'), 'unexpected internals with secret', null]) {
			const message = selfHostedConnectionMessage(error, 'https://crate.example');
			expect(message).toContain('Could not connect to Crate');
			expect(message).not.toContain('secret');
		}
	});
});

it('explains DNS sync errors without hiding unrelated sync failures', () => {
	expect(syncConnectionFailureMessage('net::ERR_NAME_NOT_RESOLVED', 'https://old.trycloudflare.com')).toContain('latest HTTPS address');
	expect(syncConnectionFailureMessage('Could not apply remote changes', 'https://old.trycloudflare.com')).toBeNull();
});
