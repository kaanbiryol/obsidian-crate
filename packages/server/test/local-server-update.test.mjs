import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, updateGlobalInstall } from '../src/commands/update.mjs';

/** @param {Partial<import('../src/commands/update.mjs').UpdateSteps> & { check?: object }} overrides */
function steps({ check = { requiresMigration: false }, ...overrides } = {}) {
	/** @type {string[]} */
	const calls = [];
	/** @type {import('../src/commands/update.mjs').UpdateSteps} */
	const fake = {
		latest: async () => '1.1.0',
		running: async () => false,
		service: async () => ({ installed: true, running: true, dataDir: '/data' }),
		stop: async () => { calls.push('stop'); },
		start: async () => { calls.push('start'); },
		backup: async output => { calls.push(`backup ${output}`); return output; },
		install: async version => { calls.push(`install ${version}`); },
		crate: async args => { calls.push(args.slice(0, 2).join(' ')); return JSON.stringify(check); },
		waitRunning: async () => true,
		metadata: async () => '{"serverRevision":1}',
		log: () => {},
		...overrides,
	};
	return { calls, fake };
}
const options = { dataDir: '/data', current: '1.0.0', backupRoot: '/backups', now: () => new Date('2026-11-21T10:00:00.000Z') };

test('compares release versions numerically', () => {
	assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
	assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
	assert.ok(compareVersions('1.2.3', '1.3.0') < 0);
});

test('stops, backs up, installs, checks and restarts the service', async () => {
	const { calls, fake } = steps();
	assert.equal(await updateGlobalInstall(options, fake), 'updated');
	assert.deepEqual(calls, ['stop', 'backup /backups/before-update-1.1.0-20261121T100000Z', 'install 1.1.0', 'check-upgrade --json', 'start']);
});

test('migrates with its own backup when the new release needs it', async () => {
	const { calls, fake } = steps({ check: { requiresMigration: true } });
	await updateGlobalInstall(options, fake);
	assert.deepEqual(calls.slice(3), ['check-upgrade --json', 'upgrade --output', 'start']);
});

test('does nothing when up to date, and refuses a server running in a terminal', async () => {
	const current = steps({ latest: async () => '1.0.0' });
	assert.equal(await updateGlobalInstall(options, current.fake), 'current');
	assert.deepEqual(current.calls, []);
	const foreground = steps({ service: async () => ({ installed: false, running: false, dataDir: null }), running: async () => true });
	await assert.rejects(updateGlobalInstall(options, foreground.fake), /running in a terminal/);
	assert.deepEqual(foreground.calls, []);
});

test('reinstalls the previous release when the new one rejects the data', async () => {
	const { calls, fake } = steps({ crate: async () => { throw new Error('Server revision is older'); } });
	await assert.rejects(updateGlobalInstall(options, fake), /stayed at 1.0.0 and your data is unchanged/);
	assert.deepEqual(calls, ['stop', 'backup /backups/before-update-1.1.0-20261121T100000Z', 'install 1.1.0', 'install 1.0.0', 'start']);
});

test('restarts the service and names the backup when reinstalling the previous release fails', async () => {
	const { calls, fake } = steps({ install: async version => { calls.push(`install ${version}`); throw new Error('npm ERR! network ETIMEDOUT'); } });
	await assert.rejects(updateGlobalInstall(options, fake), /could not be reinstalled[^]*backup is at \/backups\/before-update-1.1.0-20261121T100000Z/);
	assert.deepEqual(calls.slice(-3), ['install 1.1.0', 'install 1.0.0', 'start']);
});

test('keeps the new release when a migration fails after it started', async () => {
	const { calls, fake } = steps({ crate: async args => {
		calls.push(args.slice(0, 2).join(' '));
		if (args[0] === 'upgrade') throw new Error('Migration step failed');
		return JSON.stringify({ requiresMigration: true });
	} });
	await assert.rejects(updateGlobalInstall(options, fake), /could not finish migrating[^]*upgrade --output[^]*restore \/backups\/before-update/);
	assert.ok(!calls.includes('install 1.0.0'));
	assert.ok(!calls.includes('start'));
});

test('leaves the server as it was when the backup fails', async () => {
	const { calls, fake } = steps({ backup: async () => { throw new Error('Not enough space'); } });
	await assert.rejects(updateGlobalInstall(options, fake), /nothing changed: Not enough space/);
	assert.deepEqual(calls, ['stop', 'start']);
});

test('rolls back a release that does not start, unless it already migrated the data', async () => {
	const plain = steps({ waitRunning: async () => false });
	await assert.rejects(updateGlobalInstall(options, plain.fake), /stayed at 1.0.0/);
	assert.deepEqual(plain.calls.slice(-4), ['start', 'stop', 'install 1.0.0', 'start']);
	const migrated = steps({ waitRunning: async () => false, check: { requiresMigration: true } });
	await assert.rejects(updateGlobalInstall(options, migrated.fake), /migrated your data but did not start/);
	assert.equal(migrated.calls.filter(call => call === 'install 1.0.0').length, 0);
});

test('keeps a release that recorded its revision before failing to start, since the previous one refuses that data', async () => {
	let metadata = '{"serverRevision":1}';
	const opened = steps({ waitRunning: async () => false, start: async () => { metadata = '{"serverRevision":2}'; }, metadata: async () => metadata });
	await assert.rejects(updateGlobalInstall(options, opened.fake), /opened your data but did not start, so it stays installed and stopped/);
	assert.equal(opened.calls.filter(call => call === 'install 1.0.0').length, 0);
	assert.equal(opened.calls.at(-1), 'stop');
});

test('a stopped server is updated but not started', async () => {
	const { calls, fake } = steps({ service: async () => ({ installed: false, running: false, dataDir: null }) });
	assert.equal(await updateGlobalInstall(options, fake), 'updated');
	assert.equal(calls.includes('start') || calls.includes('stop'), false);
});
