import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installService, keepAwake, launchdPlist, protectedMacFolder, serviceState, systemdUnit, uninstallService } from '../src/local-server-service.mjs';

const command = { node: '/opt/node/bin/node', script: '/opt/crate/scripts/crate-server.mjs', dataDir: '/Users/me/.crate/my "vault" & co', keepAwake: true, log: '/Users/me/Library/Logs/crate-server.log' };

test('writes a launchd agent with exact paths, escaped', () => {
	const plist = launchdPlist(command);
	assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/opt\/crate\/scripts\/crate-server.mjs<\/string>\s*<string>start<\/string>/);
	assert.match(plist, /<string>\/Users\/me\/.crate\/my "vault" &amp; co<\/string>\s*<string>--keep-awake<\/string>/);
	assert.match(plist, /<string>\/opt\/node\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
});

test('writes a systemd unit that quotes each argument', () => {
	const unit = systemdUnit({ ...command, keepAwake: false });
	assert.match(unit, /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/crate\/scripts\/crate-server.mjs" "start" "--data-dir" "\/Users\/me\/.crate\/my \\"vault\\" & co"$/m);
	assert.doesNotMatch(unit, /keep-awake/);
	assert.match(unit, /^StandardOutput=append:\/Users\/me\/Library\/Logs\/crate-server.log$/m);
});

test('refuses macOS folders a background service cannot read', () => {
	assert.equal(protectedMacFolder('/Users/me/Documents/crate/scripts/local-server.mjs', { platform: 'darwin', home: '/Users/me' }), 'Documents');
	assert.equal(protectedMacFolder('/Users/me/.crate/server', { platform: 'darwin', home: '/Users/me' }), null);
	assert.equal(protectedMacFolder('/home/me/Documents/crate', { platform: 'linux', home: '/home/me' }), null);
});

for (const platform of /** @type {const} */ (['darwin', 'linux'])) {
	test(`installs, reports and removes the ${platform} service`, async () => {
		const home = await mkdtemp(join(tmpdir(), 'crate-service-'));
		const script = join(home, 'crate-server.mjs');
		await writeFile(script, '');
		/** @type {string[][]} */
		const calls = [];
		const run = async (/** @type {string} */ name, /** @type {string[]} */ args) => {
			calls.push([name, ...args]);
			if (args[0] === 'print') return { stdout: '\tstate = running\n' };
			if (args[1] === 'is-active') return { stdout: 'active\n' };
			return { stdout: '' };
		};
		const environment = { platform, home, uid: 501, run };
		try {
			assert.equal((await serviceState(environment)).installed, false);
			const dataDir = join(home, 'data dir');
			const { file } = await installService({ dataDir, keepAwake: false, node: '/opt/node', script }, environment);
			assert.ok((await readFile(file, 'utf8')).includes(script));
			const state = await serviceState(environment);
			assert.deepEqual({ ...state, log: undefined }, { supported: true, installed: true, running: true, keepAwake: false, dataDir, file, log: undefined });
			assert.ok(calls.some(call => platform === 'darwin' ? call.join(' ') === `launchctl bootstrap gui/501 ${file}` : call.join(' ') === 'systemctl --user enable --now crate'));
			assert.equal(await uninstallService(environment), true);
			assert.equal((await serviceState(environment)).installed, false);
			assert.equal(await uninstallService(environment), false);
		} finally { await rm(home, { recursive: true, force: true }); }
	});
}

test('keeps only a Mac awake, tied to this process', () => {
	/** @type {unknown[]} */
	const started = [];
	const start = /** @type {any} */ ((/** @type {string} */ name, /** @type {string[]} */ args) => { started.push([name, ...args]); return { on() {}, unref() {} }; });
	assert.equal(keepAwake({ platform: 'linux', start }), false);
	assert.equal(keepAwake({ platform: 'darwin', start }), true);
	assert.deepEqual(started, [['caffeinate', '-i', '-w', String(process.pid)]]);
});
