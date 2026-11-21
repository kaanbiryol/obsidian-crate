import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { MAX_FILE_MB, MIN_FILE_MB, resolveMaxFileBytes, resolveServerOrigin, resolveStartMode, validateCommandOptions } from '../src/local-server-options.mjs';

test('rejects unknown commands and conflicting options before opening data', () => {
	const rejects = (positionals, values, message, environment) => assert.throws(() => validateCommandOptions(positionals, values, environment), { message });
	rejects([], {}, 'Unknown command. Use --help for usage.');
	rejects(['start', 'extra'], {}, 'Unknown command. Use --help for usage.');
	rejects(['serve'], {}, 'Unknown command. Use --help for usage.');
	rejects(['setup'], { local: true }, 'Setup uses a loopback listener and --hostname for the public address.');
	rejects(['start'], { quick: true, origin: 'https://crate.example.com' }, '--quick cannot be combined with hostname, local, origin, host, or add-device.');
	rejects(['start'], { hostname: 'crate.example.com' }, '--hostname belongs to setup. Use --origin for an external reverse proxy.');
	rejects(['setup'], { tailscale: true, quick: true }, '--tailscale belongs to setup and cannot be combined with --hostname or --quick. Later starts reuse it.');
	rejects(['setup'], { tailscale: true }, 'In Docker, start Tailscale Funnel with compose.tailscale.yaml. See docs/self-hosting.md.', { dockerWithoutTailscale: () => true });
	rejects(['add-device'], { name: '  ' }, 'Provide --name for this device.');
	rejects(['pair'], { name: 'x'.repeat(129) }, 'Provide a device name between 1 and 128 characters.');
	for (const [positionals, values] of [[['start'], {}], [['setup'], { tailscale: true }], [['add-device'], { name: 'My Mac' }], [['setup'], { hostname: 'crate.example.com' }]]) {
		assert.doesNotThrow(() => validateCommandOptions(positionals, values), JSON.stringify({ positionals, values }));
	}
});

test('checks the Docker Tailscale socket only for --tailscale', () => {
	let checked = false;
	validateCommandOptions(['start'], {}, { dockerWithoutTailscale: () => { checked = true; return true; } });
	assert.equal(checked, false);
});

test('chooses the start mode from options and saved remote settings', () => {
	assert.deepEqual(resolveStartMode('setup', {}, null), { quick: true, tailscale: false, port: 0, host: '127.0.0.1' });
	assert.deepEqual(resolveStartMode('start', {}, null), { quick: false, tailscale: false, port: 8787, host: '127.0.0.1' });
	assert.deepEqual(resolveStartMode('start', {}, { mode: 'quick', port: 4100 }), { quick: true, tailscale: false, port: 4100, host: '127.0.0.1' });
	const funnel = { mode: 'tailscale', hostname: 'crate.example.ts.net', port: 8790 };
	assert.deepEqual(resolveStartMode('start', {}, funnel), { quick: false, tailscale: true, port: 8790, host: '127.0.0.1' });
	assert.deepEqual(resolveStartMode('start', { port: '9000', host: '0.0.0.0', origin: 'https://crate.example.com' }, null), { quick: false, tailscale: false, port: 9000, host: '0.0.0.0' });
	assert.deepEqual(resolveStartMode('setup', { hostname: 'crate.example.com' }, null), { quick: false, tailscale: false, port: 8787, host: '127.0.0.1' });
});

test('rejects start modes that conflict with saved remote settings', () => {
	const named = { hostname: 'crate.example.com', port: 8787, ready: true };
	const rejects = (command, values, remote, message) => assert.throws(() => resolveStartMode(command, values, remote), { message });
	rejects('setup', { tailscale: true }, named, 'This directory already uses another remote access setup. Keep it or choose another data directory.');
	rejects('setup', { hostname: 'crate.example.com' }, { mode: 'tailscale', hostname: 'crate.example.ts.net', port: 8787 }, 'This directory uses Tailscale Funnel. Its address comes from Tailscale, not --hostname.');
	rejects('start', { quick: true }, named, 'Quick Tunnel and named tunnel settings cannot be combined.');
	rejects('start', { port: '0' }, null, 'Port must be between 1 and 65535 (or 0 for an automatic Quick Tunnel port).');
	rejects('start', { port: '65536' }, { mode: 'quick', port: 0 }, 'Port must be between 1 and 65535 (or 0 for an automatic Quick Tunnel port).');
	const saved = 'Saved tunnel settings require their original hostname, port, and loopback listener. Use --local for an independent reverse proxy.';
	rejects('start', { port: '9000' }, named, saved);
	rejects('start', { host: '0.0.0.0' }, named, saved);
	rejects('start', { origin: 'https://other.example.com' }, named, saved);
	assert.equal(resolveStartMode('start', { origin: 'https://crate.example.com' }, named).port, 8787);
});

test('resolves the public origin and keeps plain HTTP on loopback', () => {
	assert.equal(resolveServerOrigin({ remote: null, tailscale: false, port: 8787, host: '127.0.0.1' }), 'http://localhost:8787');
	assert.equal(resolveServerOrigin({ remote: { hostname: 'crate.example.com', ready: true }, tailscale: false, port: 8787, host: '127.0.0.1' }), 'https://crate.example.com');
	assert.equal(resolveServerOrigin({ remote: { hostname: 'crate.example.ts.net' }, tailscale: true, port: 8787, host: '127.0.0.1' }), 'https://crate.example.ts.net');
	assert.equal(resolveServerOrigin({ remote: null, tailscale: false, origin: 'https://crate.example.com', port: 8787, host: '0.0.0.0' }), 'https://crate.example.com');
	assert.throws(() => resolveServerOrigin({ remote: { hostname: 'crate.example.com', ready: false }, tailscale: false, port: 8787, host: '127.0.0.1' }),
		{ message: 'Remote setup is incomplete. Run npm run server -- setup again.' });
	assert.throws(() => resolveServerOrigin({ remote: null, tailscale: false, port: 8787, host: '0.0.0.0' }),
		{ message: 'Listening beyond localhost requires --origin with the HTTPS address of your reverse proxy.' });
});

test('reads the file limit from --max-file-size or CRATE_MAX_FILE_SIZE_MB', () => {
	const MB = 1024 * 1024;
	assert.equal(resolveMaxFileBytes({}, {}), undefined);
	assert.equal(resolveMaxFileBytes({ 'max-file-size': '100' }, {}), 100 * MB);
	assert.equal(resolveMaxFileBytes({}, { CRATE_MAX_FILE_SIZE_MB: ' 128 ' }), 128 * MB);
	assert.equal(resolveMaxFileBytes({ 'max-file-size': '30' }, { CRATE_MAX_FILE_SIZE_MB: '200' }), 30 * MB);
	for (const value of ['24', '129', '1.5', 'big', '']) {
		assert.throws(() => resolveMaxFileBytes({ 'max-file-size': value }, {}), { message: '--max-file-size must be a whole number of MB from 25 to 128.' });
	}
	assert.throws(() => validateCommandOptions(['backup'], { 'max-file-size': '100' }), { message: '--max-file-size belongs to start, setup and service.' });
	assert.throws(() => validateCommandOptions(['start'], { 'max-file-size': '1000' }), { message: '--max-file-size must be a whole number of MB from 25 to 128.' });
	assert.doesNotThrow(() => validateCommandOptions(['service'], { 'max-file-size': '100' }));
});

test('mirrors the file limits in src/protocol/sync-limits.ts', async () => {
	const source = await readFile(new URL('../../../src/protocol/sync-limits.ts', import.meta.url), 'utf8');
	const megabytes = name => Number(source.match(new RegExp(`export const ${name} = (\\d+) \\* 1024 \\* 1024;`))?.[1]);
	assert.equal(MIN_FILE_MB, megabytes('MAX_FILE_SIZE_BYTES'));
	assert.equal(MAX_FILE_MB, megabytes('MAX_CONFIGURABLE_FILE_BYTES'));
});
