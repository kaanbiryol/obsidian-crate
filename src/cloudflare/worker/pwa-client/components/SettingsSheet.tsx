import React from 'react';
import { Button } from '@heroui/react';
import { RefreshCw, X } from 'lucide-react';
import { isStandaloneApp } from '../config';
import type { PushState, StoredConfig } from '../types';

export function SettingsSheet({
	config,
	push,
	onClose,
	onEnablePush,
	onRefresh,
	onLogout,
}: {
	config: StoredConfig;
	push: PushState;
	onClose: () => void;
	onEnablePush: () => void;
	onRefresh: () => void;
	onLogout: () => void;
}) {
	const installHint = /iPad|iPhone|iPod/.test(navigator.userAgent) && !isStandaloneApp()
		? 'Add this app to your Home Screen from Safari to enable the best mobile experience and notifications on iPhone.'
		: isStandaloneApp()
			? 'This device is using the installed app experience.'
			: 'You can also install this app from your browser for faster access.';

	return (
		<div className="settings-backdrop" onClick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}>
			<aside className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
				<div className="settings-handle" aria-hidden="true" />
				<div className="settings-sheet__header">
					<div>
						<h2>Settings</h2>
						<p>Notifications, install status, and the current reminder sync target for this device.</p>
					</div>
					<Button isIconOnly className="icon-button" type="button" data-action="close-settings" aria-label="Close settings" onClick={onClose}>
						<X size={20} />
					</Button>
				</div>
				<div className="settings-panel">
					<div className="settings-panel__section">
						<div className="settings-panel__title">Notifications</div>
						<div className="settings-panel__row">
							<span>{push.subscribed ? 'Enabled' : 'Disabled'}</span>
							<Button className="secondary-button" type="button" data-action="enable-push" isDisabled={!push.supported || push.subscribed} onClick={onEnablePush}>
								{push.subscribed ? 'Enabled' : 'Enable'}
							</Button>
						</div>
						{push.status && <p className="settings-panel__hint">{push.status}</p>}
					</div>
					<div className="settings-panel__section">
						<div className="settings-panel__title">Install</div>
						<p className="settings-panel__hint">{installHint}</p>
					</div>
					<div className="settings-panel__section">
						<div className="settings-panel__title">Web app</div>
						<div className="settings-panel__row"><span>Folder</span><code>{config.folderPath}</code></div>
						<div className="settings-panel__row"><span>Upcoming days</span><code>{config.upcomingDays}</code></div>
						<div className="settings-panel__row"><span>All-day time</span><code>{config.allDayNotificationTime ?? 'none'}</code></div>
						<div className="settings-panel__actions">
							<Button className="secondary-button" type="button" data-action="refresh" onClick={onRefresh}><RefreshCw size={15} /> Refresh</Button>
							<Button className="secondary-button is-danger" type="button" data-action="logout" onClick={onLogout}>Log out</Button>
						</div>
					</div>
				</div>
			</aside>
		</div>
	);
}
