import React from 'react';
import { Button } from '@heroui/react';
import {
	BellRing,
	CalendarDays,
	Check,
	Clock3,
	Folder,
	LogOut,
	RefreshCw,
	Smartphone,
	X,
} from 'lucide-react';
import { isStandaloneApp } from '../config';
import { useDialogFocus } from '../hooks/useDialogFocus';
import type { PushState, StoredConfig } from '../types';
import { PwaModalSheet } from './PwaModalSheet';

export function SettingsSheet({
	config,
	push,
	loggingOut,
	isClosing,
	onClose,
	onClosed,
	onEnablePush,
	onRefresh,
	onLogout,
}: {
	config: StoredConfig;
	push: PushState;
	loggingOut: boolean;
	isClosing: boolean;
	onClose: () => void;
	onClosed: () => void;
	onEnablePush: () => void;
	onRefresh: () => void;
	onLogout: () => void;
}) {
	const installed = isStandaloneApp();
	const installHint = /iPad|iPhone|iPod/.test(navigator.userAgent) && !installed
		? 'Add this app to your Home Screen from Safari to enable the best mobile experience and notifications on iPhone.'
		: installed
			? 'This device is using the installed app experience.'
			: 'You can also install this app from your browser for faster access.';
	const upcomingDays = `${config.upcomingDays} ${config.upcomingDays === 1 ? 'day' : 'days'}`;
	const { handleDialogKeyDown, setDialogRef } = useDialogFocus({
		activeKey: 'settings',
		escapeDisabled: loggingOut || isClosing,
		onEscape: onClose,
	});
	return (
		<PwaModalSheet
			isOpen={!isClosing}
			onClose={onClose}
			onCloseEnd={onClosed}
			variant="settings"
			detent="content"
			closeOnBackdrop={!loggingOut && !isClosing}
			onKeyDown={handleDialogKeyDown}
		>
			<aside ref={setDialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" aria-busy={loggingOut || isClosing} tabIndex={-1}>
				<div className="settings-sheet__header">
					<div className="settings-sheet__heading">
						<span className="settings-sheet__eyebrow">Device settings</span>
						<h2>Settings</h2>
						<p>Manage notifications and reminder sync on this device.</p>
					</div>
					<Button isIconOnly className="settings-sheet__close" type="button" data-action="close-settings" aria-label="Close settings" isDisabled={loggingOut || isClosing} onClick={onClose}>
						<X size={20} />
					</Button>
				</div>
				<div className="settings-panel">
					<section className="settings-panel__section" aria-labelledby="settings-notifications-title">
						<h3 id="settings-notifications-title" className="settings-panel__title">Notifications</h3>
						<div className="settings-card settings-feature-row">
							<div className="settings-feature-row__icon" aria-hidden="true"><BellRing size={21} /></div>
							<div className="settings-feature-row__copy">
								<strong>Push notifications</strong>
								<span>Get reminder alerts when Crate is closed.</span>
							</div>
							{push.subscribed ? (
								<span className="settings-status-badge is-success"><Check size={13} /> On</span>
							) : push.supported ? (
								<Button className="settings-action-button" type="button" data-action="enable-push" onClick={onEnablePush}>
									Turn on
								</Button>
							) : (
								<span className="settings-status-badge">Unavailable</span>
							)}
						</div>
						{push.status && <p className="settings-panel__hint" aria-live="polite">{push.status}</p>}
					</section>

					<section className="settings-panel__section" aria-labelledby="settings-app-title">
						<h3 id="settings-app-title" className="settings-panel__title">App</h3>
						<div className="settings-card settings-feature-row settings-feature-row--install">
							<div className="settings-feature-row__icon is-neutral" aria-hidden="true"><Smartphone size={21} /></div>
							<div className="settings-feature-row__copy">
								<strong>App experience</strong>
								<span>{installHint}</span>
							</div>
							<span className={`settings-status-badge${installed ? ' is-success' : ''}`}>
								{installed && <Check size={13} />}{installed ? 'Installed' : 'Browser'}
							</span>
						</div>
					</section>

					<section className="settings-panel__section" aria-labelledby="settings-sync-title">
						<h3 id="settings-sync-title" className="settings-panel__title">Reminder sync</h3>
						<div className="settings-card settings-list">
							<div className="settings-list__row">
								<div className="settings-list__icon" aria-hidden="true"><Folder size={18} /></div>
								<div className="settings-list__copy"><strong>Folder</strong><span>Sync target</span></div>
								<span className="settings-list__value" title={config.folderPath}>{config.folderPath}</span>
							</div>
							<div className="settings-list__row">
								<div className="settings-list__icon" aria-hidden="true"><CalendarDays size={18} /></div>
								<div className="settings-list__copy"><strong>Upcoming</strong><span>Sync window</span></div>
								<span className="settings-list__value">{upcomingDays}</span>
							</div>
							<div className="settings-list__row">
								<div className="settings-list__icon" aria-hidden="true"><Clock3 size={18} /></div>
								<div className="settings-list__copy"><strong>All-day reminders</strong><span>Notification time</span></div>
								<span className="settings-list__value">{config.allDayNotificationTime ?? 'Not set'}</span>
							</div>
						</div>
					</section>
				</div>
				<div className="settings-sheet__footer">
					<Button className="settings-refresh-button" type="button" data-action="refresh" onClick={onRefresh}>
						<RefreshCw size={17} /> Refresh reminders
					</Button>
					<Button className="settings-logout-button" type="button" data-action="logout" isDisabled={loggingOut} onClick={onLogout}>
						<LogOut size={17} /> {loggingOut ? 'Logging out...' : 'Log out'}
					</Button>
				</div>
			</aside>
		</PwaModalSheet>
	);
}
