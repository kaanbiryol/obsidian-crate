// The questions setup asks in a terminal when no options choose for it: how devices
// reach this computer, whether Crate starts at login and stays awake, and where daily
// backups go. It only decides; commands/start.mjs carries the choices out.
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {object} WizardChoices
 * @property {'tailscale' | 'domain' | 'quick'} access
 * @property {string} [hostname] The named tunnel's hostname, for `domain`.
 * @property {boolean} service Start at login and keep running.
 * @property {boolean} keepAwake
 * @property {string | null} backupDir
 */

/**
 * @typedef {object} WizardEnvironment
 * @property {(question: string) => Promise<string>} ask
 * @property {(message: string) => void} [log]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [home]
 * @property {() => Promise<unknown>} findTailscale Rejects with install guidance.
 */

/** A folder on this computer. Backups hold vault contents and server credentials, so they
 * leave it only when the person chooses a synced folder such as iCloud Drive.
 * @param {{ home?: string }} [options] */
export function defaultBackupDir({ home = homedir() } = {}) {
	return join(home, 'Crate backups');
}

/** The iCloud Drive backup folder, when this Mac has iCloud Drive.
 * @param {{ platform?: NodeJS.Platform, home?: string }} [options] @returns {Promise<string | null>} */
export async function icloudBackupDir({ platform = process.platform, home = homedir() } = {}) {
	const icloud = join(home, 'Library/Mobile Documents/com~apple~CloudDocs');
	return platform === 'darwin' && await access(icloud).then(() => true, () => false) ? join(icloud, 'Crate backups') : null;
}

/** @param {WizardEnvironment['ask']} ask @param {string} question @param {string[]} options @returns {Promise<number>} */
async function choose(ask, question, options) {
	const list = options.map((option, index) => `  ${index + 1}. ${option}`).join('\n');
	for (;;) {
		const answer = (await ask(`${question}\n${list}\nChoose 1-${options.length} [1]: `)).trim();
		if (!answer) return 0;
		const index = Number(answer) - 1;
		if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
	}
}

/** @param {WizardEnvironment['ask']} ask @param {string} question @param {boolean} fallback */
async function confirm(ask, question, fallback) {
	for (;;) {
		const answer = (await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
		if (!answer) return fallback;
		if (['y', 'yes'].includes(answer)) return true;
		if (['n', 'no'].includes(answer)) return false;
	}
}

/** @param {WizardEnvironment} environment @returns {Promise<WizardChoices>} */
export async function runSetupWizard({ ask, log = console.log, platform = process.platform, home = homedir(), findTailscale }) {
	log('Set up Crate on this computer. Press Enter to accept the suggestion in [brackets].\n');
	/** @type {WizardChoices['access']} */
	let access;
	/** @type {string | undefined} */
	let hostname;
	for (;;) {
		const index = await choose(ask, 'How will your phone and other devices reach this computer?', [
			'Tailscale Funnel: a permanent address, free, no domain needed (recommended)',
			'My own domain on Cloudflare, such as crate.example.com',
			'A temporary address to try Crate out (changes every restart)',
		]);
		access = /** @type {const} */ (['tailscale', 'domain', 'quick'])[index];
		if (access !== 'tailscale') break;
		try { await findTailscale(); break; }
		catch (error) { log(`${error.message}\nInstall Tailscale, sign in, and choose it again, or pick another option.\n`); }
	}
	if (access === 'domain') {
		while (!hostname) hostname = (await ask('Public hostname on your Cloudflare domain (e.g. crate.example.com): ')).trim() || undefined;
	}
	const supported = platform === 'darwin' || platform === 'linux';
	const service = supported && access !== 'quick'
		&& await confirm(ask, 'Start Crate when you log in, and restart it if it stops?', true);
	const keepAwake = platform === 'darwin' && await confirm(ask, 'Keep this Mac awake while Crate runs, so devices can always sync?', true);
	const suggested = defaultBackupDir({ home });
	const icloud = await icloudBackupDir({ platform, home });
	if (icloud) log(`To also keep backups off this computer, type ${icloud}. Backups hold your vault and server credentials, so iCloud stores those too.`);
	const backup = (await ask(`Back up daily to this folder (type none to skip) [${suggested}]: `)).trim();
	const backupDir = backup.toLowerCase() === 'none' ? null : backup || suggested;
	return { access, ...(hostname ? { hostname } : {}), service, keepAwake, backupDir };
}
