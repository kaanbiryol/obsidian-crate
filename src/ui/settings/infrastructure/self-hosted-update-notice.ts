import { Setting } from 'obsidian';
import release from '../../../cloudflare/server-release.json';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from '../../../cloudflare/deployment/embedded-artifacts';
import { serverBuildLabel } from '../../../protocol/server-build';
import type { CrateServerInfo } from '../../../protocol/server-info';
import type CratePlugin from '../../../plugin/CratePlugin';
import { isBundledServerNewer } from '../../../plugin/cloudflare/server-version';
import type { SettingsSectionContext } from '../section-helpers';

const CHECK_INTERVAL_MS = 10 * 60_000;
const checks = new WeakMap<CratePlugin, { url: string; at: number; info: Promise<CrateServerInfo | null> }>();

/** Settings rerender often, so the live server is asked at most once per interval. */
function serverInfo(plugin: CratePlugin, url: string): Promise<CrateServerInfo | null> {
	const previous = checks.get(plugin);
	if (previous?.url === url && Date.now() - previous.at < CHECK_INTERVAL_MS) return previous.info;
	const info = plugin.syncRuntime.getVersionInfo().catch(() => null);
	checks.set(plugin, { url, at: Date.now(), info });
	return info;
}

/** A self-hosted server is updated on its host, so this only says that an update exists. */
export function renderSelfHostedUpdateNotice({ containerEl, plugin }: SettingsSectionContext): (() => void) | void {
	const url = plugin.settings.workerUrl;
	if (!plugin.syncRuntime.isConfigured() || plugin.settings.cloudflareDeployment || !url) return;
	const slot = containerEl.createDiv();
	let active = true;
	void serverInfo(plugin, url).then(info => {
		if (!active || !info || url !== plugin.settings.workerUrl || !isBundledServerNewer(info)) return;
		const current = info.serverRevision ? serverBuildLabel(info.serverRevision, info.developmentBuild) : 'Unknown';
		new Setting(slot).setName('Server update available')
			.setDesc(`Current version: ${current} · Bundled version: ${serverBuildLabel(release.revision, EMBEDDED_CLOUDFLARE_ARTIFACT.development)}. Update Crate on the computer running your server, then restart it.`);
	});
	return () => { active = false; };
}
