import React from 'react';
import { Button } from '@heroui/react';
import { PWA_ASSET_VERSION } from '../../pwa-version';
import { isStandaloneApp } from '../config';
import type { StoredConfig } from '../types';

const brandMarkSrc = `/notifications/crate-mark-256.png?v=${PWA_ASSET_VERSION}`;

function AuthBrandMark() {
	return <img className="auth-card__mark" src={brandMarkSrc} alt="" aria-hidden="true" />;
}

function openObsidianRecoveryLink() {
	window.location.href = '/notifications/open-obsidian';
}

export function EmptyAuthState({ config }: { config: StoredConfig }) {
	const standalone = isStandaloneApp();
	return (
		<div className="auth-card">
			<AuthBrandMark />
			<h1>Crate Reminders</h1>
			<p>{standalone
				? 'Open Crate in Obsidian and send a new app link to reconnect this Home Screen app.'
				: 'Open a fresh link from Crate to activate this web app on your device.'}</p>
			<p>Your reminders folder setting is preserved: {config.folderPath}</p>
			<Button className="primary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian</Button>
		</div>
	);
}

export function LoadingAuthState({ isExiting = false }: { isExiting?: boolean }) {
	return (
		<div
			className={`auth-card auth-card--loading${isExiting ? ' is-exiting' : ''}`}
			role="status"
			aria-live="polite"
			aria-label="Loading reminders"
		>
			<div className="auth-loading__mark-stage" aria-hidden="true">
				<img src={brandMarkSrc} alt="" />
			</div>
		</div>
	);
}

export function ErrorState({ error, config, onRetry }: { error: string; config: StoredConfig; onRetry: () => void }) {
	const standalone = isStandaloneApp();
	return (
		<div className="auth-card">
			<AuthBrandMark />
			<h1>Crate Reminders</h1>
			<p>{error || 'Something went wrong.'}</p>
			<p>{standalone
				? 'Open Crate in Obsidian and send a new app link if this app can no longer authenticate.'
				: 'Retry, or open a fresh link from Crate if this browser is no longer authenticated.'}</p>
			<p>Your reminders folder setting is preserved: {config.folderPath}</p>
			<Button className="secondary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian</Button>
			<Button className="primary-button" type="button" onClick={onRetry}>Retry</Button>
		</div>
	);
}
