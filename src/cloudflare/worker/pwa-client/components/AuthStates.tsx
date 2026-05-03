import React from 'react';
import { Button } from '@heroui/react';
import { isStandaloneApp } from '../config';
import type { StoredConfig } from '../types';

function openObsidianRecoveryLink() {
	window.location.href = '/notifications/open-obsidian';
}

export function EmptyAuthState({ config }: { config: StoredConfig }) {
	const standalone = isStandaloneApp();
	return (
		<div className="auth-card">
			<h1>Crate Reminders</h1>
			<p>{standalone
				? 'Open Crate in Obsidian and send a new app link to reconnect this Home Screen app.'
				: 'Open a fresh link from Crate to activate this web app on your device.'}</p>
			<p>Your reminders folder setting is preserved: {config.folderPath}</p>
			<Button className="primary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian</Button>
		</div>
	);
}

export function LoadingAuthState() {
	return (
		<div className="auth-card">
			<h1>Crate Reminders</h1>
			<p>Loading reminders...</p>
		</div>
	);
}

export function ErrorState({ error, config, onRetry }: { error: string; config: StoredConfig; onRetry: () => void }) {
	const standalone = isStandaloneApp();
	return (
		<div className="auth-card">
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
