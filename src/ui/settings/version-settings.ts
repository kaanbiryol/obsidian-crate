import { Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import release from '../../cloudflare/server-release.json';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from '../../cloudflare/embedded-artifacts';

export function renderVersionSettings(container: HTMLElement, plugin: CratePlugin): void {
	new Setting(container).setName('Plugin version').setDesc(plugin.manifest.version);
	new Setting(container).setName('Bundled server').setDesc(`Revision ${release.revision}`);
	const server = new Setting(container).setName('Connected server').setDesc('Select the button to check the server version.');
	server.addButton(button => button.setButtonText('Check version').onClick(async () => {
		button.setDisabled(true);
		server.setDesc('Checking version…');
		try {
			const info = await plugin.syncRuntime.getVersionInfo();
			const version = info.serverRevision ? `Revision ${info.serverRevision}` : 'Revision unknown';
			const comparison = info.deploymentFingerprint
				? info.deploymentFingerprint === EMBEDDED_CLOUDFLARE_ARTIFACT.fingerprint
					? 'Matches the bundled server.' : 'Differs from the bundled server.'
				: 'Build comparison unavailable.';
			server.setDesc(`${version} · ${comparison}`);
		} catch {
			server.setDesc('Version unavailable. Connect to the server to check.');
		} finally {
			button.setDisabled(false);
		}
	}));
}

export function renderUpdateVersions(setting: Setting, plugin: CratePlugin, onMatchingServer: () => void): void {
	const target = `revision ${release.revision} (${EMBEDDED_CLOUDFLARE_ARTIFACT.fingerprint.slice(0, 8)})`;
	setting.setDesc(`Server revision unknown → ${target}. Update your sync server and reminders web app, or check if the update already completed.`);
	setting.addButton(button => button.setButtonText('Check live server').onClick(async () => {
		button.setDisabled(true);
		setting.setDesc('Checking live server…');
		try {
			const info = await plugin.syncRuntime.getVersionInfo();
			if (info.deploymentFingerprint === EMBEDDED_CLOUDFLARE_ARTIFACT.fingerprint) {
				onMatchingServer();
				return;
			}
			setting.setDesc(`Server ${info.serverRevision ? `revision ${info.serverRevision}` : 'revision unknown'} → ${target}. Update your sync server and reminders web app.`);
		} catch {
			setting.setDesc(`Could not check the live server. Update it to ${target}, or try checking again.`);
		} finally {
			button.setDisabled(false);
		}
	}));
}
