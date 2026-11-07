import { canReplaceServerBuild } from '../../protocol/server-build';
import type CratePlugin from '../CratePlugin';
import release from '../../cloudflare/server-release.json';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from '../../cloudflare/deployment/embedded-artifacts';
import type { CrateServerInfo } from '../../protocol/server-info';
import { isManagedDeploymentUrl } from '../../cloudflare/deployment/worker-origin';

/** Reads the live server's version and records a managed deployment's revision. Rejects when
 * the server address or deployment changed during the read. */
export async function checkServerVersion(plugin: CratePlugin): Promise<CrateServerInfo> {
	const deployment = plugin.settings.cloudflareDeployment;
	const url = plugin.settings.workerUrl;
	const info = await plugin.syncRuntime.getVersionInfo();
	const current = plugin.settings.cloudflareDeployment;
	if (url !== plugin.settings.workerUrl || deployment?.workerName !== current?.workerName
		|| deployment?.accountId !== current?.accountId || deployment?.d1DatabaseId !== current?.d1DatabaseId) throw new Error('Server connection changed');
	if (deployment && deployment === plugin.settings.cloudflareDeployment && url === plugin.settings.workerUrl
		&& isManagedDeploymentUrl(plugin.settings)
		&& info.serverRevision && deployment.lastKnownRevision !== info.serverRevision) {
		await plugin.writeSettings({ cloudflareDeployment: { ...deployment, lastKnownRevision: info.serverRevision } });
	}
	return info;
}

/** True when the live server runs an older revision, or a different build this plugin's bundled server can replace. */
export function isBundledServerNewer(info: Pick<CrateServerInfo, 'serverRevision' | 'deploymentFingerprint' | 'developmentBuild'>): boolean {
	const bundled = { revision: release.revision, fingerprint: EMBEDDED_CLOUDFLARE_ARTIFACT.fingerprint, development: EMBEDDED_CLOUDFLARE_ARTIFACT.development };
	if (!info.serverRevision) return false;
	if (info.serverRevision < bundled.revision) return true;
	const fingerprint = info.deploymentFingerprint;
	return Boolean(fingerprint && fingerprint !== bundled.fingerprint
		&& canReplaceServerBuild({ revision: info.serverRevision, fingerprint, development: info.developmentBuild }, bundled));
}
