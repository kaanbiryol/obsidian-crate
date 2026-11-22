import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultBackupDir, icloudBackupDir, runSetupWizard } from '../src/local-server-wizard.mjs';

/** @param {string[]} answers */
function script(answers) {
	/** @type {string[]} */
	const asked = [];
	return { asked, ask: async (/** @type {string} */ question) => { asked.push(question); return answers.shift() ?? ''; } };
}
const log = () => {};

test('accepting every suggestion sets up Tailscale as a service, awake, with daily backups', async () => {
	const { ask } = script([]);
	const choices = await runSetupWizard({ ask, log, platform: 'darwin', home: '/Users/me', findTailscale: async () => 'tailscale' });
	assert.deepEqual(choices, { access: 'tailscale', service: true, keepAwake: true, backupDir: '/Users/me/Crate backups' });
});

test('offers another choice when Tailscale is missing, and asks for the domain hostname', async () => {
	const { ask } = script(['1', '2', '', 'crate.example.com', 'n', 'none']);
	const choices = await runSetupWizard({ ask, log, platform: 'linux', home: '/home/me', findTailscale: async () => { throw new Error('Install Tailscale'); } });
	assert.deepEqual(choices, { access: 'domain', hostname: 'crate.example.com', service: false, keepAwake: false, backupDir: null });
});

test('a temporary address never becomes a service, and invalid answers ask again', async () => {
	const { ask, asked } = script(['7', '3', 'maybe', 'n', '/backups']);
	const choices = await runSetupWizard({ ask, log, platform: 'darwin', home: '/Users/me', findTailscale: async () => {} });
	assert.deepEqual(choices, { access: 'quick', service: false, keepAwake: false, backupDir: '/backups' });
	assert.equal(asked.filter(question => question.includes('Start Crate when you log in')).length, 0);
	assert.equal(asked.filter(question => question.includes('How will your phone')).length, 2);
});

test('backs up on this computer by default and offers iCloud Drive only by name', async () => {
	const home = await mkdtemp(join(tmpdir(), 'crate-wizard-'));
	try {
		assert.equal(await icloudBackupDir({ platform: 'darwin', home }), null);
		await mkdir(join(home, 'Library/Mobile Documents/com~apple~CloudDocs'), { recursive: true });
		assert.equal(defaultBackupDir({ home }), join(home, 'Crate backups'));
		assert.equal(await icloudBackupDir({ platform: 'darwin', home }), join(home, 'Library/Mobile Documents/com~apple~CloudDocs/Crate backups'));
		assert.equal(await icloudBackupDir({ platform: 'linux', home }), null);
	} finally { await rm(home, { recursive: true, force: true }); }
});
