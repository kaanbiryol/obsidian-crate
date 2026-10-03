import { canReplaceServerBuild, serverBuildLabel, type DevelopmentBuild } from '../../cloudflare/server-build';
import { Setting, type ButtonComponent } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import release from '../../cloudflare/server-release.json';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from '../../cloudflare/embedded-artifacts';
import type { CrateServerInfo } from '../../protocol';

function localRevision(plugin: CratePlugin): number | undefined {
	const deployment = plugin.settings.cloudflareDeployment;
	if (!deployment || plugin.settings.workerUrl !== `https://${deployment.workerName}.${deployment.workersSubdomain}.workers.dev`) return undefined;
	return deployment.lastKnownRevision;
}

async function checkVersion(plugin: CratePlugin) {
	const deployment = plugin.settings.cloudflareDeployment;
	const url = plugin.settings.workerUrl;
	const info = await plugin.syncRuntime.getVersionInfo();
	const current = plugin.settings.cloudflareDeployment;
	if (url !== plugin.settings.workerUrl || deployment?.workerName !== current?.workerName
		|| deployment?.accountId !== current?.accountId || deployment?.d1DatabaseId !== current?.d1DatabaseId) throw new Error('Server connection changed');
	if (deployment && deployment === plugin.settings.cloudflareDeployment && url === plugin.settings.workerUrl
		&& url === `https://${deployment.workerName}.${deployment.workersSubdomain}.workers.dev`
		&& info.serverRevision && deployment.lastKnownRevision !== info.serverRevision) {
		await plugin.writeSettings({ cloudflareDeployment: { ...deployment, lastKnownRevision: info.serverRevision } });
	}
	return info;
}

export function renderVersionSettings(container: HTMLElement, plugin: CratePlugin): void {
	new Setting(container).setName('Plugin version').setDesc(plugin.manifest.version);
	new Setting(container).setName('Bundled server').setDesc(`Revision ${serverBuildLabel(release.revision, EMBEDDED_CLOUDFLARE_ARTIFACT.development)}`);
	const revision = localRevision(plugin);
	const server = new Setting(container).setName('Connected server').setDesc(revision
		? `Last known server revision: ${revision}.` : 'No saved server revision. Select the button to check.');
	server.addButton(button => button.setButtonText('Check version').onClick(async () => {
		button.setDisabled(true);
		server.setDesc('Checking version…');
		try {
			const info = await checkVersion(plugin);
			const version = info.serverRevision ? `Revision ${serverBuildLabel(info.serverRevision, info.developmentBuild)}` : 'Revision unknown';
			const comparison = info.deploymentFingerprint
				? info.deploymentFingerprint === EMBEDDED_CLOUDFLARE_ARTIFACT.fingerprint
					? 'Matches the bundled server.' : 'Differs from the bundled server.'
				: 'Build comparison unavailable.';
			server.setDesc(`${version} · ${comparison}`);
		} catch {
			server.setDesc(`${localRevision(plugin) ? `Last known server revision: ${localRevision(plugin)}. ` : ''}Could not check the live server. Try again when connected.`);
		} finally {
			button.setDisabled(false);
		}
	}));
}

export function renderUpdateVersions(setting: Setting, plugin: CratePlugin, onMatchingServer: () => void, onAvailability?: (available: boolean) => void): void {
	let checkButton: ButtonComponent | undefined;
	let updateAvailable = false;
	const setAvailability = (available: boolean) => {
		updateAvailable = available;
		if (checkButton) {
			if (available) checkButton.buttonEl.hide();
			else checkButton.buttonEl.show();
		}
		onAvailability?.(available);
	};
	const describe = (revision: number | undefined, development?: DevelopmentBuild, fingerprint?: string) => {
		const versions = `Current version: ${revision ? serverBuildLabel(revision, development) : 'Unknown'} · Bundled version: ${serverBuildLabel(release.revision, EMBEDDED_CLOUDFLARE_ARTIFACT.development)}`;
		const designated = !EMBEDDED_CLOUDFLARE_ARTIFACT.development || EMBEDDED_CLOUDFLARE_ARTIFACT.development.worker === plugin.settings.cloudflareDeployment?.workerName;
    const available = designated && revision !== undefined && (revision < release.revision || Boolean(fingerprint && canReplaceServerBuild(
      { revision, fingerprint, development }, { revision: release.revision, fingerprint: EMBEDDED_CLOUDFLARE_ARTIFACT.fingerprint, development: EMBEDDED_CLOUDFLARE_ARTIFACT.development })));
    setAvailability(available);
    if (available) { setting.setName('Cloudflare update available'); return versions; }
		if (revision === undefined) {
			setting.setName('Check server version');
			return versions;
		}
		if (revision === release.revision) {
			if (!fingerprint) {
				setting.setName('Check server version');
				return `${versions}. Check for updates to compare the installed build.`;
			}
			setting.setName('Server build differs');
			return `${versions}. Update the plugin to get a newer server release.`;
		}
		if (revision > release.revision) {
			setting.setName('Plugin update required');
			return `${versions}. Update the plugin first.`;
		}
		setting.setName('Cloudflare update available');
		return versions;
	};
	let saved = describe(localRevision(plugin));
	setting.setDesc(saved);
	const showVersion = (info: CrateServerInfo) => {
		if (info.deploymentFingerprint === EMBEDDED_CLOUDFLARE_ARTIFACT.fingerprint) {
			checkButton?.buttonEl.hide();
			onMatchingServer();
			return;
		}
		saved = describe(info.serverRevision, info.developmentBuild, info.deploymentFingerprint);
		if (!info.deploymentFingerprint) {
			setAvailability(false);
			setting.setName('Check server version');
			saved = `Current version: ${info.serverRevision ? serverBuildLabel(info.serverRevision, info.developmentBuild) : 'Unknown'} · Bundled version: ${serverBuildLabel(release.revision, EMBEDDED_CLOUDFLARE_ARTIFACT.development)}. Build unverified. Retry when connected.`;
		}
		setting.setDesc(saved);
	};
	setting.addButton(button => {
		checkButton = button;
		if (updateAvailable) button.buttonEl.hide();
		const check = async () => {
			button.setDisabled(true).setButtonText('Checking…');
			setting.setDesc('Checking live server…');
			try {
				showVersion(await checkVersion(plugin));
			} catch {
				setting.setDesc(`${saved}. Could not check the server. Try again.`);
			} finally {
				button.setDisabled(false).setButtonText('Check for updates');
			}
		};
		button.setButtonText('Check for updates').onClick(check);
		const cached = plugin.syncRuntime.getCachedVersionInfo();
		if (cached) showVersion(cached);
		else if (!updateAvailable && (localRevision(plugin) === undefined || localRevision(plugin) === release.revision)) void check();
	});
}
