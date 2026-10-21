import React, { useEffect, useState } from 'react';
import { parseCrateServerInfo, type CrateServerInfo } from '@/protocol/server-info';
import release from '@/cloudflare/server-release.json';
import { PWA_ASSET_VERSION } from '@/pwa/shell/version';
import { CopyableText } from '@/ui/shared/CopyableText';
import { SettingsRow } from './SettingsRow';
import { fetchPwaAssetVersion } from '../update/update-checker';

export function VersionSettings() {
	const [server, setServer] = useState<CrateServerInfo | null>(null);
	const [asset, setAsset] = useState<string | null>(null);
	const [checking, setChecking] = useState(true);
	const diagnostics = JSON.stringify({
		format: 'crate-version-diagnostics', webAppRevision: release.revision, webAppBuild: PWA_ASSET_VERSION,
		serverRevision: server?.serverRevision ?? null, serverBuild: asset,
		serverFingerprint: server?.deploymentFingerprint ?? null,
	}, null, 2);
	useEffect(() => {
		let active = true;
		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), 15_000);
		void Promise.allSettled([
			fetch('/.well-known/crate', { cache: 'no-store', signal: controller.signal })
				.then(async response => response.ok ? parseCrateServerInfo(await response.json()) : null),
			fetchPwaAssetVersion(),
		]).then(([info, version]) => {
			if (!active) return;
			setServer(info.status === 'fulfilled' ? info.value : null);
			setAsset(version.status === 'fulfilled' ? version.value : null);
			setChecking(false);
		}).finally(() => window.clearTimeout(timer));
		return () => { active = false; controller.abort(); window.clearTimeout(timer); };
	}, []);
	return <>
		<SettingsRow className="settings-row--value settings-row--version"><span>Version</span><strong title={PWA_ASSET_VERSION}>Revision {release.revision} · {PWA_ASSET_VERSION.slice(0, 8)}</strong></SettingsRow>
		{!checking && server?.serverRevision !== undefined && server.serverRevision !== release.revision && <SettingsRow className="settings-row--value settings-row--version"><span>Server</span><strong title={asset ?? undefined}>Revision {server.serverRevision}{asset ? ` · ${asset.slice(0, 8)}` : ''}</strong></SettingsRow>}
		<SettingsRow className="settings-row--diagnostics">
			<CopyableText value={diagnostics} label="Version diagnostics" copyLabel="Copy diagnostics"
				successMessage="Version details copied."
				failureMessage="Select and copy the version details below."
				fieldClassName="settings-diagnostics-text" buttonClassName="settings-action-row" />
		</SettingsRow>
	</>;
}
