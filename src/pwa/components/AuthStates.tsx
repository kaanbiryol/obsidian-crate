import React from 'react';
import { Folder, ExternalLink, RefreshCw } from 'lucide-react';
import { PwaButton as Button } from './PwaButton';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { isStandaloneApp } from '../config';
import type { StoredConfig } from '../types';

const brandMarkSrc = `/notifications/crate-mark-256.png?v=${PWA_ASSET_VERSION}`;

function AuthBrandMark() {
	return <img className="auth-card__mark" src={brandMarkSrc} alt="" aria-hidden="true" />;
}

function openObsidianRecoveryLink() {
	window.location.href = '/notifications/open-obsidian';
}

function AuthLayout({ title, description, detail, config, children }: {
	title: string;
	description: string;
	detail?: string;
	config: StoredConfig;
	children: React.ReactNode;
}) {
	return (
		<main className="auth-card">
			<header className="auth-card__brand"><AuthBrandMark /><span>Crate</span></header>
			<section className="auth-card__content" aria-labelledby="auth-title">
				<div className="auth-card__heading">
					<h1 id="auth-title">{title}</h1>
					<p>{description}</p>
					{detail && <p role="alert">{detail}</p>}
				</div>
				<div className="auth-card__folder">
					<Folder size={18} aria-hidden="true" />
					<div><span>Reminders folder</span><strong>{config.folderPath}</strong></div>
					<span className="auth-card__saved">Saved</span>
				</div>
				<div className="auth-card__actions">{children}</div>
			</section>
		</main>
	);
}

export function EmptyAuthState({ config }: { config: StoredConfig }) {
	return (
		<AuthLayout
			title="Connect to Crate"
			description={isStandaloneApp()
				? 'Open Crate in Obsidian and send a new app link to connect this app.'
				: 'Open a new app link from Crate in Obsidian to connect this browser.'}
			config={config}
		>
			<Button className="primary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian<ExternalLink size={16} aria-hidden="true" /></Button>
		</AuthLayout>
	);
}

export function ErrorState({ error, config, onRetry }: { error: string; config: StoredConfig; onRetry: () => void }) {
	const needsLink = /enrollment token|session expired|not authenticated|unauthorized|missing auth token/i.test(error);
	return (
		<AuthLayout
			title={needsLink ? 'Reconnect to Crate' : 'Unable to connect'}
			detail={error || undefined}
			description={needsLink
				? 'Your app link has expired or is no longer valid. Open Crate in Obsidian and send a new app link.'
				: 'Crate couldn’t connect. Check your connection and try again. If this continues, open a new app link from Crate in Obsidian.'}
			config={config}
		>
			{needsLink ? (
				<>
					<Button className="primary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian<ExternalLink size={16} aria-hidden="true" /></Button>
					<Button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
				</>
			) : (
				<>
					<Button className="primary-button" type="button" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
					<Button className="secondary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian<ExternalLink size={16} aria-hidden="true" /></Button>
				</>
			)}
		</AuthLayout>
	);
}
