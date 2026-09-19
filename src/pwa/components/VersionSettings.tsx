import React, { useEffect, useState } from 'react';
import { parseCrateServerInfo, type CrateServerInfo } from '@/protocol';
import release from '@/cloudflare/server-release.json';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { fetchPwaAssetVersion } from '../api';
import { PwaButton } from './PwaButton';

export function VersionSettings() {
	const [server, setServer] = useState<CrateServerInfo | null>(null);
	const [asset, setAsset] = useState<string | null>(null);
	const [checking, setChecking] = useState(true);
	const [copyStatus, setCopyStatus] = useState('');
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
	return <section className="settings-panel__section" aria-labelledby="settings-about-title">
		<h3 id="settings-about-title" className="settings-panel__title">About</h3>
		<div className="settings-group">
			<div className="settings-row settings-row--value"><span>Web app</span><strong title={PWA_ASSET_VERSION}>Revision {release.revision} · {PWA_ASSET_VERSION.slice(0, 8)}</strong></div>
			<div className="settings-row settings-row--value"><span>Server</span><strong title={asset ?? undefined}>{checking ? 'Checking…' : server?.serverRevision ? `Revision ${server.serverRevision}${asset ? ` · ${asset.slice(0, 8)}` : ''}` : 'Version unavailable'}</strong></div>
			<div className="settings-row"><div className="settings-row__copy">
				<span>{checking ? 'Checking web app build…' : asset ? asset === PWA_ASSET_VERSION
					? 'This web app matches the server build.' : 'This web app differs from the server build. An update may be waiting to load.'
					: 'Build comparison unavailable while the server cannot be reached.'}</span>
			</div></div>
			<div className="settings-row"><div className="settings-row__copy"><span role="status">{copyStatus || 'Version details for troubleshooting.'}</span></div>
				<PwaButton className="settings-action-button" type="button" onClick={async () => {
					try {
					await navigator.clipboard.writeText(JSON.stringify({
						format: 'crate-version-diagnostics', webAppRevision: release.revision, webAppBuild: PWA_ASSET_VERSION,
						serverRevision: server?.serverRevision ?? null, serverBuild: asset,
						serverFingerprint: server?.deploymentFingerprint ?? null,
					}, null, 2));
					setCopyStatus('Version details copied.');
					} catch { setCopyStatus('Could not copy version details.'); }
				}}>Copy diagnostics</PwaButton>
			</div>
		</div>
	</section>;
}
