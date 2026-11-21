import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose } from '../src/commands/doctor.mjs';

const now = Date.parse('2026-11-21T12:00:00Z');
/** @param {Partial<import('../src/commands/doctor.mjs').DoctorProbes>} overrides */
const probes = overrides => ({
	node: '26.10.0', hasData: true, dataDir: '/data', command: (/** @type {string} */ args) => `crate-server ${args}`, now: () => now,
	running: async () => ({ origin: 'https://mac.tail1234.ts.net', autoBackup: { settings: {}, lastFailure: null } }),
	remote: async () => ({ mode: 'tailscale', hostname: 'mac.tail1234.ts.net' }),
	reachable: async () => true,
	tailscale: async () => 'mac.tail1234.ts.net',
	cloudflared: async () => true,
	service: async () => ({ supported: true, installed: true, running: true, keepAwake: true, dataDir: '/data' }),
	autoBackup: async () => ({ dir: '/backups' }),
	lastBackup: async () => ({ createdAt: '2026-11-21T03:00:00Z' }),
	free: async () => 50 * 1024 ** 3,
	sleepMinutes: async () => 10,
	...overrides,
});
const statuses = (/** @type {{ status: string, name: string }[]} */ checks) => Object.fromEntries(checks.map(check => [check.name, check.status]));

test('passes a server set up by the wizard', async () => {
	const checks = await diagnose(probes({}));
	assert.ok(checks.every(check => check.status === 'pass'), JSON.stringify(checks));
	assert.deepEqual(Object.keys(statuses(checks)), ['Node.js', 'Server data', 'Running', 'Start at login', 'Tailscale', 'Public address', 'Daily backups', 'Last backup', 'Disk space']);
});

test('fails what breaks sync and warns about what makes it fragile, with a fix each', async () => {
	const checks = await diagnose(probes({
		running: async () => ({ origin: 'https://mac.tail1234.ts.net', autoBackup: { settings: {}, lastFailure: { at: '2026-11-21T11:00:00Z' } } }),
		reachable: async () => false,
		tailscale: async () => 'renamed.tail1234.ts.net',
		service: async () => ({ supported: true, installed: false, running: false, keepAwake: false, dataDir: null }),
		lastBackup: async () => ({ createdAt: '2026-11-15T03:00:00Z' }),
		free: async () => 1024 ** 3,
	}));
	assert.deepEqual(statuses(checks), { 'Node.js': 'pass', 'Server data': 'pass', Running: 'pass', 'Start at login': 'warn', Tailscale: 'fail',
		'Public address': 'fail', 'Daily backups': 'fail', 'Last backup': 'warn', 'Disk space': 'fail', Sleep: 'warn' });
	assert.match(checks.find(check => check.name === 'Start at login')?.detail ?? '', /crate-server service/);
	assert.match(checks.find(check => check.name === 'Sleep')?.detail ?? '', /service --keep-awake/);
});

test('stops early without server data, and explains a stopped or local-only server', async () => {
	assert.deepEqual(statuses(await diagnose(probes({ hasData: false }))), { 'Node.js': 'pass', 'Server data': 'fail' });
	const checks = await diagnose(probes({ running: async () => null, remote: async () => null, autoBackup: async () => null, lastBackup: async () => null, sleepMinutes: async () => 0 }));
	assert.deepEqual(statuses(checks), { 'Node.js': 'pass', 'Server data': 'pass', Running: 'fail', 'Start at login': 'pass', 'Remote access': 'warn', 'Daily backups': 'warn', 'Disk space': 'pass' });
});
