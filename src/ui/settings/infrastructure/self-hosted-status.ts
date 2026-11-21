import { Notice, Setting } from 'obsidian';
import type { HostInstall, HostStatus } from '../../../protocol/host-status';
import type CratePlugin from '../../../plugin/CratePlugin';
import { formatTimeAgo } from '../../shared/format';

type StatusPlugin = Pick<CratePlugin, 'syncRuntime' | 'settings'>;

const CHECK_INTERVAL_MS = 60_000;
const LOW_DISK_BYTES = 2 * 1024 ** 3;
const checks = new WeakMap<StatusPlugin, { url: string; at: number; status: Promise<HostStatus | null> }>();

/** Settings rerender often, so the server is asked at most once a minute. */
export function loadHostStatus(plugin: StatusPlugin): Promise<HostStatus | null> {
	const url = plugin.settings.workerUrl;
	const previous = checks.get(plugin);
	if (previous && previous.url === url && Date.now() - previous.at < CHECK_INTERVAL_MS) return previous.status;
	const api = plugin.syncRuntime.getApiClient();
	const status = api ? Promise.resolve().then(() => api.getHostStatus()).catch(() => null) : Promise.resolve(null);
	checks.set(plugin, { url, at: Date.now(), status });
	return status;
}

const PREFIX: Record<HostInstall, string> = {
	npm: 'crate-server', npx: 'npx @kaanbiryol/crate-server', docker: 'docker compose exec crate crate', source: 'npm run server --',
};
const UPDATE: Record<HostInstall, string> = {
	npm: 'crate-server update',
	npx: 'npx @kaanbiryol/crate-server@latest',
	docker: 'docker compose pull && docker compose up -d',
	source: 'git pull && npm ci && npm run build:worker',
};
const INSTALL_LABEL: Record<HostInstall, string> = { npm: 'npm', npx: 'npx', docker: 'Docker', source: 'a source checkout' };

/** The command that issues a pairing code on the server computer; a plain one when its install is unknown. */
export function pairCommand(install: HostInstall | undefined): string {
	return `${PREFIX[install ?? 'npm']} pair --name "My phone"`;
}

export function updateCommand(install: HostInstall): string {
	return UPDATE[install];
}

const ago = (time: string, now: number) => formatTimeAgo(Date.parse(time), now);
const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** One line of facts and, separately, what needs the owner's attention. */
export function describeHostStatus(status: HostStatus, now = Date.now()): { summary: string; warnings: string[] } {
	const facts = [`Installed with ${INSTALL_LABEL[status.install]}`, `running since ${ago(status.startedAt, now)}`,
		status.lastBackupAt ? `last backup ${ago(status.lastBackupAt, now)}` : 'no backup yet',
		status.autoBackup.on ? 'daily backups on' : 'daily backups off'];
	if (status.publicAccess === 'ready') facts.push('reachable from the internet');
	const warnings: string[] = [];
	if (status.autoBackup.lastFailureAt) warnings.push(`The last automatic backup failed ${ago(status.autoBackup.lastFailureAt, now)}.`);
	if (!status.autoBackup.on) warnings.push(`Turn on daily backups on the server computer: ${PREFIX[status.install]} auto-backup --output PATH`);
	if (status.publicAccess === 'waiting') warnings.push('Your server is not reachable from the internet right now.');
	if (status.diskFreeBytes !== null && status.diskFreeBytes < LOW_DISK_BYTES) warnings.push(`Only ${gigabytes(status.diskFreeBytes)} of disk space is left on the server computer.`);
	if (warnings.length) warnings.push(`For details, run ${PREFIX[status.install]} doctor on that computer.`);
	return { summary: `${facts.join(' · ')}.`, warnings };
}

/** The self-hosted server's health, as its host process last reported it. */
export function renderSelfHostedStatus(containerEl: HTMLElement, plugin: StatusPlugin): () => void {
	const setting = new Setting(containerEl).setName('Server computer')
		.setDesc('Manage updates, backups, and new devices on the computer running this server.');
	let active = true;
	void loadHostStatus(plugin).then(status => {
		if (!active || !status) return;
		const { summary, warnings } = describeHostStatus(status);
		setting.setDesc(summary);
		for (const warning of warnings) setting.descEl.createDiv({ cls: 'crate-diagnostic-warn', text: warning });
	});
	return () => { active = false; };
}

/** Pairing codes come only from the server computer, so this shows the command that makes one. */
export function renderSelfHostedAddDevice(containerEl: HTMLElement, plugin: StatusPlugin): () => void {
	const setting = new Setting(containerEl).setName('Add a device');
	let command = pairCommand(undefined);
	const describe = () => setting.setDesc(`On the computer running your server, run ${command}. Scan the QR code it shows with the new device, or open its link there.`);
	describe();
	setting.addButton(button => button.setButtonText('Copy command').onClick(async () => {
		try {
			await navigator.clipboard.writeText(command);
			new Notice('Command copied');
		} catch {
			new Notice('Could not copy the command. Select and copy it manually.');
		}
	}));
	let active = true;
	void loadHostStatus(plugin).then(status => {
		if (!active || !status) return;
		command = pairCommand(status.install);
		describe();
	});
	return () => { active = false; };
}
