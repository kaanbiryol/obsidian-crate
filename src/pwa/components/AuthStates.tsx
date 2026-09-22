import React from 'react';
import { Folder, ExternalLink, RefreshCw, Link2Off, WifiOff, TriangleAlert } from 'lucide-react';
import { PwaButton as Button } from './PwaButton';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { isStandaloneApp } from '../config';
import type { StoredConfig } from '../types';
import { FeatureSwitcherButton } from './FeatureSwitcherButton';

const brandMarkSrc = `/notifications/crate-mark-256.png?v=${PWA_ASSET_VERSION}`;

function AuthBrandMark() {
	return <img className="auth-card__mark" src={brandMarkSrc} alt="" aria-hidden="true" />;
}

function openObsidianRecoveryLink() {
	window.location.href = '/notifications/open-obsidian';
}

function AuthLayout({ title, description, notice, config, children }: {
	title: string;
	description: string;
	notice?: React.ReactNode;
	config: StoredConfig;
	children: React.ReactNode;
}) {
	return (
		<main className="auth-card">
			<header className="auth-card__brand"><AuthBrandMark /><span>Crate</span><FeatureSwitcherButton /></header>
			<section className="auth-card__content" aria-labelledby="auth-title">
				<div className="auth-card__heading">
					<h1 id="auth-title">{title}</h1>
					<p>{description}</p>
				</div>
				{notice}
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
	const needsCleanup = /clear this site[’']s data|remote cleanup could not finish/i.test(error);
	const needsLink = /enrollment token|session expired|not authenticated|unauthorized|missing auth token/i.test(error);
	return (
		<AuthLayout
			title={needsCleanup ? 'Cleanup needs attention' : needsLink ? 'Reconnect to Crate' : 'Unable to connect'}
			description={needsCleanup
				? 'Some data or session access could not be removed. Follow the steps below to finish cleanup.'
				: needsLink
				? 'Open Crate in Obsidian and send a new app link to reconnect.'
				: 'Check your internet connection and try again.'}
			notice={
				<div className="auth-card__notice" role="alert">
					{needsCleanup ? <TriangleAlert size={20} aria-hidden="true" /> : needsLink ? <Link2Off size={20} aria-hidden="true" /> : <WifiOff size={20} aria-hidden="true" />}
					<div>
						<strong>{needsCleanup ? 'Cleanup is incomplete' : needsLink ? 'A new app link is needed' : 'Crate couldn’t be reached'}</strong>
						<p>{error}</p>
					</div>
				</div>
			}
			config={config}
		>
			{needsCleanup ? (
				<Button className="primary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian<ExternalLink size={16} aria-hidden="true" /></Button>
			) : needsLink ? (
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
